import { detectAllAgents, getAdapter } from "./adapters/index.ts";
import { compactSession } from "./session.ts";
import { AGENT_META } from "./types.ts";
import type {
  AgentAvailability,
  AgentId,
  McliConfig,
  MemoryConfig,
  SessionData,
} from "./types.ts";

/**
 * Default cheap, fast model per firm when acting as the Memory Scribe.
 * Keeps memory management inexpensive so flagship models (opus, gpt-5.6-sol, etc.)
 * don't burn tokens re-reading raw transcripts or summarizing history.
 */
export const FAST_MEMORY_MODELS: Record<AgentId, string> = {
  deepseek: "deepseek-chat",
  claude: "haiku",
  agy: "gemini-2.5-flash",
  codex: "o4-mini",
  kimi: "kimi-k2-turbo-preview",
};

/** Cheapest-first priority when `memory.agent === "auto"` */
const AUTO_SCRIBE_PRIORITY: AgentId[] = ["deepseek", "claude", "agy", "codex", "kimi"];

export interface ResolvedMemoryScribe {
  kind: "agent" | "local";
  agent?: AgentId;
  model?: string;
  label: string;
}

export function resolveMemoryScribe(
  config: McliConfig,
  availability?: Record<AgentId, AgentAvailability>,
): ResolvedMemoryScribe {
  const mem = config.memory;

  if (mem.agent === "local") {
    return { kind: "local", label: "local digest ($0 / 0 tokens)" };
  }

  const avail = availability ?? detectAllAgents(config);

  if (mem.agent !== "auto") {
    const id = mem.agent;
    const model = mem.model || FAST_MEMORY_MODELS[id];
    if (avail[id]?.available) {
      return {
        kind: "agent",
        agent: id,
        model,
        label: `${AGENT_META[id].label} (${model})`,
      };
    }
    return {
      kind: "local",
      label: `local digest (configured scribe --${id} unavailable)`,
    };
  }

  for (const id of AUTO_SCRIBE_PRIORITY) {
    if (avail[id]?.available) {
      const model = mem.model || FAST_MEMORY_MODELS[id];
      return {
        kind: "agent",
        agent: id,
        model,
        label: `${AGENT_META[id].label} (${model}) [auto]`,
      };
    }
  }

  return { kind: "local", label: "local digest ($0 / 0 tokens)" };
}

/**
 * Returns the effective context window limits for the active MemoryMode:
 *  - lean:     rolling summary + last 1 verbatim turn (~6k chars max) -> lowest token burn
 *  - balanced: rolling summary + last 2–4 verbatim turns (~14k chars max)
 *  - full:     user's full maxContextTurns / maxContextChars
 */
export function getEffectiveContextConfig(
  config: McliConfig,
  shareContextOverride?: boolean,
): Pick<McliConfig, "shareContext" | "maxContextTurns" | "maxContextChars"> {
  const shareContext = shareContextOverride ?? config.shareContext;
  const mode = config.memory?.mode ?? "balanced";

  if (mode === "lean") {
    return {
      shareContext,
      maxContextTurns: Math.min(config.maxContextTurns, 2),
      maxContextChars: Math.min(config.maxContextChars, 6000),
    };
  }
  if (mode === "balanced") {
    return {
      shareContext,
      maxContextTurns: Math.min(config.maxContextTurns, 6),
      maxContextChars: Math.min(config.maxContextChars, 14000),
    };
  }
  return {
    shareContext,
    maxContextTurns: config.maxContextTurns,
    maxContextChars: config.maxContextChars,
  };
}

export function getKeepRecentTurns(memory: MemoryConfig): number {
  if (memory.mode === "lean") return 1;
  if (memory.mode === "balanced") return 2;
  return 4;
}

/**
 * Checks whether the unsummarized tail of `session` is large enough to warrant
 * automatic background compaction by the cheap Memory Scribe.
 */
export function shouldAutoCompact(session: SessionData, config: McliConfig): boolean {
  const mem = config.memory;
  if (!mem?.autoCompact || mem.mode === "full") return false;

  const startIdx = Math.max(0, Math.min(session.summarizedUpTo ?? 0, session.messages.length));
  const tail = session.messages.slice(startIdx);
  const keepRecent = getKeepRecentTurns(mem);

  let userTurns = 0;
  let totalChars = 0;
  for (const m of tail) {
    if (m.role === "system") continue;
    if (m.role === "user") userTurns++;
    totalChars += m.content.length;
  }

  if (userTurns <= keepRecent) return false;

  const threshold =
    mem.mode === "lean"
      ? Math.min(mem.autoCompactThresholdChars, 3000)
      : mem.autoCompactThresholdChars;

  return totalChars >= threshold || userTurns >= keepRecent + 3;
}

export interface MemoryScribeResult {
  compactedTurns: number;
  scribeLabel: string;
  mode: "agent" | "local";
  savedChars: number;
  estimatedTokensSaved: number;
  summary: string;
}

/**
 * Runs the configured cheap Memory Scribe agent (e.g. Haiku / DeepSeek-chat / Flash / o4-mini
 * or zero-token local digest) to compress older turns into `session.summary`.
 */
export async function runMemoryScribe(opts: {
  session: SessionData;
  cwd: string;
  config: McliConfig;
  availability?: Record<AgentId, AgentAvailability>;
  forceLocal?: boolean;
  keepRecentTurns?: number;
  signal?: AbortSignal;
}): Promise<MemoryScribeResult> {
  const scribe = opts.forceLocal
    ? { kind: "local" as const, label: "local digest ($0 / 0 tokens)" }
    : resolveMemoryScribe(opts.config, opts.availability);

  const startIdx = Math.max(
    0,
    Math.min(opts.session.summarizedUpTo ?? 0, opts.session.messages.length),
  );
  const beforeSummaryLen = (opts.session.summary ?? "").length;
  const keepRecent = opts.keepRecentTurns ?? getKeepRecentTurns(opts.config.memory);

  // Measure characters in messages that will be compacted
  const userIndices: number[] = [];
  for (let i = startIdx; i < opts.session.messages.length; i++) {
    if (opts.session.messages[i].role === "user") userIndices.push(i);
  }
  const cutIndex =
    keepRecent === 0
      ? opts.session.messages.length
      : userIndices.length > keepRecent
        ? userIndices[userIndices.length - keepRecent]
        : startIdx;

  let rawCompactedChars = 0;
  for (let i = startIdx; i < cutIndex; i++) {
    rawCompactedChars += opts.session.messages[i].content.length;
  }

  const res = await compactSession({
    session: opts.session,
    cwd: opts.cwd,
    keepRecentTurns: keepRecent,
    fast: scribe.kind === "local",
    adapter: scribe.kind === "agent" && scribe.agent ? getAdapter(scribe.agent) : undefined,
    agentConfig:
      scribe.kind === "agent" && scribe.agent ? opts.config.agents[scribe.agent] : undefined,
    model: scribe.model,
    signal: opts.signal,
  });

  const addedSummaryChars = Math.max(0, res.summary.length - beforeSummaryLen);
  const savedChars = Math.max(0, rawCompactedChars - addedSummaryChars);

  return {
    compactedTurns: res.compactedTurns,
    scribeLabel: res.mode === "agent" ? scribe.label : "local digest ($0 / 0 tokens)",
    mode: res.mode,
    savedChars,
    estimatedTokensSaved: Math.round(savedChars / 4),
    summary: res.summary,
  };
}
