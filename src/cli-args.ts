import { resolveModelAlias } from "./models.ts";
import { AGENT_IDS, targetKey } from "./types.ts";
import type { AgentId, AgentTarget } from "./types.ts";

export interface ParsedCliArgs {
  agents: AgentId[];
  agentModels: Partial<Record<AgentId, string>>;
  targets: AgentTarget[];
  promptParts: string[];
  prompt: string;
  model?: string;
  session?: string;
  discuss?: boolean;
  discussionRounds?: number;
  noSynthesis: boolean;
  newSession: boolean;
  noContext: boolean;
  plain: boolean;
  status: boolean;
  listModels: boolean;
  initConfig: boolean;
  help: boolean;
  version: boolean;
  passthroughArgs: string[];
  unknownFlags: string[];
}

export interface ParsedInlineInput {
  agents: AgentId[];
  agentModels: Partial<Record<AgentId, string>>;
  targets: AgentTarget[];
  modelOverride?: string;
  discuss?: boolean;
  discussionRounds?: number;
  noSynthesis: boolean;
  listModels: boolean;
  prompt: string;
  switchOnly: boolean;
  isSlashCommand: boolean;
  command?: string;
  commandArgs?: string;
}

const AGENT_SET = new Set<string>(AGENT_IDS);

const RESERVED_FLAGS = new Set<string>([
  "-h",
  "--help",
  "-v",
  "--version",
  "--status",
  "--doctor",
  "--models",
  "--model",
  "-m",
  "--session",
  "-s",
  "--new",
  "--no-context",
  "--plain",
  "--no-tui",
  "--init-config",
  "--discuss",
  "--discussion",
  "--debate",
  "--agent-discussion",
  "--agent",
  "--no-discuss",
  "--no-discussion",
  "--rounds",
  "--no-synthesis",
]);

export function isAgentId(value: string): value is AgentId {
  return AGENT_SET.has(value);
}

export function isReservedFlag(token: string): boolean {
  const lower = token.toLowerCase();
  if (RESERVED_FLAGS.has(lower)) return true;
  const eqIdx = lower.indexOf("=");
  if (eqIdx !== -1 && RESERVED_FLAGS.has(lower.slice(0, eqIdx))) return true;
  return false;
}

export function parseAgentToken(token: string): { agent: AgentId; model?: string } | undefined {
  let body: string | undefined;
  if (token.startsWith("--")) {
    body = token.slice(2);
  } else if (token.startsWith("@")) {
    body = token.slice(1);
  }
  if (!body) return undefined;

  const colonIdx = body.indexOf(":");
  if (colonIdx !== -1) {
    const name = body.slice(0, colonIdx).toLowerCase();
    const rawModel = body.slice(colonIdx + 1).trim();
    if (isAgentId(name) && rawModel.length > 0) {
      return { agent: name, model: resolveModelAlias(name, rawModel) };
    }
    return undefined;
  }

  const name = body.toLowerCase();
  if (isAgentId(name)) {
    return { agent: name };
  }
  return undefined;
}

export function flagToAgent(token: string): AgentId | undefined {
  return parseAgentToken(token)?.agent;
}

/**
 * Deduplicates AgentTarget[] by (agent, model) pair while preserving order,
 * and upgrades a bare { agent } entry if a model is attached to it.
 */
function finalizeTargets(rawTargets: AgentTarget[]): {
  targets: AgentTarget[];
  agents: AgentId[];
  agentModels: Partial<Record<AgentId, string>>;
} {
  const targets: AgentTarget[] = [];
  const seenKeys = new Set<string>();
  const agents: AgentId[] = [];
  const agentModels: Partial<Record<AgentId, string>> = {};

  for (const t of rawTargets) {
    const key = targetKey(t);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      targets.push(t);
    }
    if (!agents.includes(t.agent)) {
      agents.push(t.agent);
    }
    if (t.model && !agentModels[t.agent]) {
      agentModels[t.agent] = t.model;
    }
  }

  return { targets, agents, agentModels };
}

function isDiscussionFlag(token: string, nextToken: string | undefined): {
  matched: boolean;
  value?: boolean;
  consumeNext?: boolean;
} {
  const lower = token.toLowerCase();
  if (
    lower === "--discuss" ||
    lower === "--discussion" ||
    lower === "--debate" ||
    lower === "--agent-discussion" ||
    lower === "--agent=discussion"
  ) {
    return { matched: true, value: true };
  }
  if (lower === "--no-discuss" || lower === "--no-discussion") {
    return { matched: true, value: false };
  }
  if (lower === "--agent" && nextToken && /^discussion[.,;!?]*$/i.test(nextToken)) {
    return { matched: true, value: true, consumeNext: true };
  }
  return { matched: false };
}

function parseRoundsNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(6, n);
}

/**
 * Checks whether a token immediately following an agent flag (e.g. `--codex --gpt-5.6-sol`)
 * should be interpreted as a shorthand model selector for that agent.
 */
function parseShorthandModelFlag(token: string, agent: AgentId): string | undefined {
  if (!token.startsWith("--") || token.length <= 2) return undefined;
  if (isReservedFlag(token)) return undefined;
  if (parseAgentToken(token)) return undefined;
  // Strip trailing punctuation if someone wrote `--opus,` or `--gpt-5.6-sol.`
  const cleaned = token.slice(2).replace(/[,;]+$/, "");
  if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) return undefined;
  return resolveModelAlias(agent, cleaned);
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const rawTargets: AgentTarget[] = [];
  const promptParts: string[] = [];
  const passthroughArgs: string[] = [];
  const unknownFlags: string[] = [];

  let model: string | undefined;
  let session: string | undefined;
  let discuss: boolean | undefined;
  let discussionRounds: number | undefined;
  let noSynthesis = false;
  let newSession = false;
  let noContext = false;
  let plain = false;
  let status = false;
  let listModels = false;
  let initConfig = false;
  let help = false;
  let version = false;

  let inPassthrough = false;
  let pendingModelTarget: AgentTarget | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (inPassthrough) {
      passthroughArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      inPassthrough = true;
      pendingModelTarget = undefined;
      continue;
    }

    const disc = isDiscussionFlag(arg, argv[i + 1]);
    if (disc.matched) {
      discuss = disc.value;
      pendingModelTarget = undefined;
      if (disc.consumeNext) i++;
      continue;
    }

    if (arg === "--no-synthesis") {
      noSynthesis = true;
      pendingModelTarget = undefined;
      continue;
    }

    if (arg === "--rounds") {
      const n = parseRoundsNumber(argv[i + 1]);
      if (n !== undefined) {
        discussionRounds = n;
        if (discuss === undefined) discuss = true;
        i++;
      }
      pendingModelTarget = undefined;
      continue;
    }
    if (arg.startsWith("--rounds=")) {
      const n = parseRoundsNumber(arg.slice("--rounds=".length));
      if (n !== undefined) {
        discussionRounds = n;
        if (discuss === undefined) discuss = true;
      }
      pendingModelTarget = undefined;
      continue;
    }

    const parsedAgent = parseAgentToken(arg);
    if (parsedAgent) {
      const target: AgentTarget = { agent: parsedAgent.agent, model: parsedAgent.model };
      rawTargets.push(target);
      pendingModelTarget = parsedAgent.model ? undefined : target;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      help = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--status" || arg === "--doctor") {
      status = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--models") {
      listModels = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--init-config") {
      initConfig = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--plain" || arg === "--no-tui") {
      plain = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--new") {
      newSession = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--no-context") {
      noContext = true;
      pendingModelTarget = undefined;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const next = argv[i + 1];
      if (next !== undefined) {
        if (pendingModelTarget) {
          const resolved = resolveModelAlias(pendingModelTarget.agent, next);
          pendingModelTarget.model = resolved;
          if (!model && rawTargets.length === 1) model = resolved;
          pendingModelTarget = undefined;
        } else {
          model = next;
        }
        i++;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      const val = arg.slice("--model=".length);
      if (pendingModelTarget) {
        const resolved = resolveModelAlias(pendingModelTarget.agent, val);
        pendingModelTarget.model = resolved;
        if (!model && rawTargets.length === 1) model = resolved;
        pendingModelTarget = undefined;
      } else {
        model = val;
      }
      continue;
    }
    if (arg === "--session" || arg === "-s") {
      const next = argv[i + 1];
      if (next !== undefined) {
        session = next;
        i++;
      }
      pendingModelTarget = undefined;
      continue;
    }
    if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
      pendingModelTarget = undefined;
      continue;
    }

    // Shorthand model flag right after an agent: e.g. `--codex --gpt-5.6-sol` or `--claude --opus`
    if (pendingModelTarget) {
      const shorthand = parseShorthandModelFlag(arg, pendingModelTarget.agent);
      if (shorthand) {
        pendingModelTarget.model = shorthand;
        pendingModelTarget = undefined;
        continue;
      }
    }

    pendingModelTarget = undefined;

    if (arg.startsWith("-") && promptParts.length === 0 && rawTargets.length === 0) {
      unknownFlags.push(arg);
      continue;
    }

    promptParts.push(arg);
  }

  const { targets, agents, agentModels } = finalizeTargets(rawTargets);

  return {
    agents,
    agentModels,
    targets,
    promptParts,
    prompt: promptParts.join(" ").trim(),
    model,
    session,
    discuss,
    discussionRounds,
    noSynthesis,
    newSession,
    noContext,
    plain,
    status,
    listModels,
    initConfig,
    help,
    version,
    passthroughArgs,
    unknownFlags,
  };
}

interface InlineToken {
  text: string;
  quoted: boolean;
}

function tokenizeInline(raw: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;

    const quote = raw[i] === '"' || raw[i] === "'" ? raw[i] : "";
    if (quote) {
      let j = i + 1;
      while (j < raw.length && raw[j] !== quote) j++;
      if (j < raw.length) {
        tokens.push({ text: raw.slice(i, j + 1), quoted: true });
        i = j + 1;
        continue;
      }
    }

    let j = i;
    while (j < raw.length && !/\s/.test(raw[j])) j++;
    tokens.push({ text: raw.slice(i, j), quoted: false });
    i = j;
  }
  return tokens;
}

/**
 * Parses an interactive chat message, supporting agent/model flags and
 * `--agent discussion` / `--discuss` anywhere in the line:
 *   "--codex --gpt-5.6-sol --claude --opus --agent discussion investigate heavy quarks"
 *   "investigate heavy quarks --codex --gpt-5.6-sol --claude --opus --discuss"
 *   "--claude:opus --deepseek:reasoner compare these two designs"
 *   "--agy" or "--claude --opus" (switches active agent / model without sending a prompt)
 *   "--models" or "--codex --models"
 *   "/model" or "/discuss on" (slash command)
 */
export function parseInlineInput(raw: string): ParsedInlineInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      agents: [],
      agentModels: {},
      targets: [],
      noSynthesis: false,
      listModels: false,
      prompt: "",
      switchOnly: false,
      isSlashCommand: false,
    };
  }

  if (trimmed.startsWith("/")) {
    const spaceIdx = trimmed.search(/\s/);
    const command = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const commandArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    return {
      agents: [],
      agentModels: {},
      targets: [],
      noSynthesis: false,
      listModels: false,
      prompt: "",
      switchOnly: false,
      isSlashCommand: true,
      command,
      commandArgs,
    };
  }

  const tokens = tokenizeInline(trimmed);
  const rawTargets: AgentTarget[] = [];
  const promptTokens: string[] = [];
  let modelOverride: string | undefined;
  let discuss: boolean | undefined;
  let discussionRounds: number | undefined;
  let noSynthesis = false;
  let listModels = false;
  let pendingModelTarget: AgentTarget | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const text = tok.text;

    if (tok.quoted) {
      pendingModelTarget = undefined;
      promptTokens.push(text);
      continue;
    }

    if (text === "--models") {
      listModels = true;
      pendingModelTarget = undefined;
      continue;
    }

    const nextText = tokens[i + 1] && !tokens[i + 1].quoted ? tokens[i + 1].text : undefined;
    const disc = isDiscussionFlag(text, nextText);
    if (disc.matched) {
      discuss = disc.value;
      pendingModelTarget = undefined;
      if (disc.consumeNext) i++;
      continue;
    }

    if (text === "--no-synthesis") {
      noSynthesis = true;
      pendingModelTarget = undefined;
      continue;
    }

    if (text === "--rounds") {
      const n = parseRoundsNumber(nextText);
      if (n !== undefined) {
        discussionRounds = n;
        if (discuss === undefined) discuss = true;
        i++;
        pendingModelTarget = undefined;
        continue;
      }
    }
    if (text.startsWith("--rounds=")) {
      const n = parseRoundsNumber(text.slice("--rounds=".length));
      if (n !== undefined) {
        discussionRounds = n;
        if (discuss === undefined) discuss = true;
        pendingModelTarget = undefined;
        continue;
      }
    }

    if (text === "--model" || text === "-m") {
      if (nextText) {
        if (pendingModelTarget) {
          pendingModelTarget.model = resolveModelAlias(pendingModelTarget.agent, nextText);
          pendingModelTarget = undefined;
        } else {
          modelOverride = nextText;
        }
        i++;
        continue;
      }
    }
    if (text.startsWith("--model=")) {
      const val = text.slice("--model=".length);
      if (val) {
        if (pendingModelTarget) {
          pendingModelTarget.model = resolveModelAlias(pendingModelTarget.agent, val);
          pendingModelTarget = undefined;
        } else {
          modelOverride = val;
        }
        continue;
      }
    }

    const parsedAgent = parseAgentToken(text);
    if (parsedAgent) {
      const target: AgentTarget = { agent: parsedAgent.agent, model: parsedAgent.model };
      rawTargets.push(target);
      pendingModelTarget = parsedAgent.model ? undefined : target;
      continue;
    }

    if (pendingModelTarget) {
      const shorthand = parseShorthandModelFlag(text, pendingModelTarget.agent);
      if (shorthand) {
        pendingModelTarget.model = shorthand;
        pendingModelTarget = undefined;
        continue;
      }
    }

    pendingModelTarget = undefined;
    promptTokens.push(text);
  }

  const { targets, agents, agentModels } = finalizeTargets(rawTargets);
  const prompt = promptTokens.join(" ").trim();

  return {
    agents,
    agentModels,
    targets,
    modelOverride,
    discuss,
    discussionRounds,
    noSynthesis,
    listModels,
    prompt,
    switchOnly: !listModels && (targets.length > 0 || Boolean(modelOverride)) && prompt.length === 0,
    isSlashCommand: false,
  };
}
