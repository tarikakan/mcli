import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSessionsDir } from "./config.ts";
import { AGENT_META } from "./types.ts";
import type { AgentAdapter, AgentConfig, AgentId, ChatMessage, McliConfig, SessionData } from "./types.ts";

export function createMessageId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function sanitizeSessionSlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

export function getWorkspaceSessionId(cwd: string): string {
  const base = sanitizeSessionSlug(path.basename(cwd) || "workspace");
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function createSession(opts: {
  name?: string;
  cwd: string;
  activeAgent: AgentId;
}): SessionData {
  const now = new Date().toISOString();
  const id = opts.name ? sanitizeSessionSlug(opts.name) : getWorkspaceSessionId(opts.cwd);
  return {
    id,
    name: opts.name || path.basename(opts.cwd) || "default",
    cwd: opts.cwd,
    createdAt: now,
    updatedAt: now,
    activeAgent: opts.activeAgent,
    messages: [],
    agentSessions: {},
  };
}

export function getSessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sanitizeSessionSlug(sessionId)}.json`);
}

export function getSessionTranscriptPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sanitizeSessionSlug(sessionId)}.md`);
}

/**
 * Persists both the structured JSON session and a human- & agent-readable
 * Markdown transcript (`~/.mcli/sessions/<id>.md`) as Tier 3 memory.
 */
export function saveSession(session: SessionData): string {
  session.updatedAt = new Date().toISOString();
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getSessionFilePath(session.id);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
  try {
    const mdPath = getSessionTranscriptPath(session.id);
    fs.writeFileSync(mdPath, exportSessionMarkdown(session), "utf8");
  } catch {
    // non-fatal if markdown mirror cannot be written
  }
  return filePath;
}

/**
 * Saves/snapshots the current session under a new named session ID.
 */
export function saveSessionAs(session: SessionData, newName: string): SessionData {
  const slug = sanitizeSessionSlug(newName);
  const cloned: SessionData = {
    ...session,
    id: slug,
    name: newName.trim() || slug,
    updatedAt: new Date().toISOString(),
    messages: session.messages.map((m) => ({ ...m })),
    agentSessions: { ...session.agentSessions },
  };
  saveSession(cloned);
  return cloned;
}

export function loadSession(sessionId: string): SessionData | undefined {
  const filePath = getSessionFilePath(sessionId);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SessionData;
    if (!parsed || !Array.isArray(parsed.messages)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function listSessions(): Array<{
  id: string;
  name: string;
  cwd: string;
  updatedAt: string;
  messageCount: number;
  activeAgent: AgentId;
  hasSummary: boolean;
}> {
  const dir = getSessionsDir();
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const sessions: Array<{
      id: string;
      name: string;
      cwd: string;
      updatedAt: string;
      messageCount: number;
      activeAgent: AgentId;
      hasSummary: boolean;
    }> = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const data = JSON.parse(raw) as SessionData;
        if (data && data.id && Array.isArray(data.messages)) {
          sessions.push({
            id: data.id,
            name: data.name || data.id,
            cwd: data.cwd || "",
            updatedAt: data.updatedAt || data.createdAt || "",
            messageCount: data.messages.length,
            activeAgent: data.activeAgent || "claude",
            hasSummary: Boolean(data.summary && data.summary.trim().length > 0),
          });
        }
      } catch {
        // skip unreadable session file
      }
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function loadOrCreateSession(opts: {
  name?: string;
  cwd: string;
  activeAgent: AgentId;
  fresh?: boolean;
}): SessionData {
  const targetId = opts.name ? sanitizeSessionSlug(opts.name) : getWorkspaceSessionId(opts.cwd);
  if (!opts.fresh) {
    const existing = loadSession(targetId);
    if (existing) {
      existing.cwd = opts.cwd;
      return existing;
    }
  }
  return createSession({
    name: opts.name,
    cwd: opts.cwd,
    activeAgent: opts.activeAgent,
  });
}

interface TurnGroup {
  user?: ChatMessage;
  assistants: ChatMessage[];
}

function groupMessagesIntoTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  for (const msg of messages) {
    if (msg.role === "system" || !msg.content.trim()) continue;
    if (msg.role === "user") {
      current = { user: msg, assistants: [] };
      groups.push(current);
    } else if (msg.role === "assistant") {
      if (!current) {
        current = { assistants: [] };
        groups.push(current);
      }
      current.assistants.push(msg);
    }
  }

  return groups;
}

function formatSpeaker(msg: ChatMessage): string {
  if (msg.role === "user") return "User";
  const label = msg.agent ? AGENT_META[msg.agent].label : "agent";
  const modelPart = msg.model ? ` / ${msg.model}` : "";
  const roundPart = msg.roundLabel ? ` · ${msg.roundLabel}` : "";
  return `Assistant (${label}${modelPart}${roundPart})`;
}

function formatSingleMessage(msg: ChatMessage): string {
  let body = msg.content.trim();
  if (msg.tools && msg.tools.length > 0) {
    const toolSummary = msg.tools
      .slice(0, 6)
      .map((t) => (t.detail ? `${t.name}(${t.detail})` : t.name))
      .join(", ");
    body = `[Tools used: ${toolSummary}]\n${body}`;
  }
  return `### ${formatSpeaker(msg)}\n${body}`;
}

/**
 * Tier 2 Smart Discussion Folding:
 * For older turn groups that concluded with a "Final Synthesis", folds the
 * intermediate Round 1/2 drafts into a 1-line participant header while keeping
 * the Final Synthesis intact. The most recent turn group stays expanded.
 */
function formatTurnGroup(
  group: TurnGroup,
  opts: { foldDiscussion: boolean },
): { text: string; folded: boolean } {
  const parts: string[] = [];
  let folded = false;

  if (group.user) {
    parts.push(formatSingleMessage(group.user));
  }

  const synthesis = group.assistants.find(
    (m) => m.roundLabel?.toLowerCase() === "final synthesis",
  );

  if (opts.foldDiscussion && synthesis && group.assistants.length > 1) {
    folded = true;
    const participants = Array.from(
      new Set(
        group.assistants
          .filter((m) => m !== synthesis)
          .map((m) => {
            const label = m.agent ? AGENT_META[m.agent].label : "agent";
            return m.model ? `${label} (${m.model})` : label;
          }),
      ),
    );
    parts.push(
      `> [Earlier discussion folded: ${participants.join(" ↔ ")} (${group.assistants.length - 1} round messages omitted; consensus below)]`,
    );
    parts.push(formatSingleMessage(synthesis));
  } else {
    for (const a of group.assistants) {
      parts.push(formatSingleMessage(a));
    }
  }

  return { text: parts.join("\n\n"), folded };
}

/**
 * Builds a compact deterministic digest of turns that fell outside the recent
 * char/turn window, ensuring nothing from earlier in the conversation is ever
 * silently dropped.
 */
export function buildLocalDigest(messages: ChatMessage[], maxChars = 4000): string {
  const groups = groupMessagesIntoTurns(messages);
  if (groups.length === 0) return "";

  const lines: string[] = [];
  let remaining = maxChars;

  for (const g of groups) {
    const q = g.user
      ? g.user.content.replace(/\s+/g, " ").trim().slice(0, 140)
      : "(continued)";

    const synthesis = g.assistants.find((m) => m.roundLabel?.toLowerCase() === "final synthesis");
    const keyAssistants = synthesis ? [synthesis] : g.assistants.slice(-2);

    const answerSummaries = keyAssistants.map((a) => {
      const who = a.agent ? AGENT_META[a.agent].label : "Agent";
      const mod = a.model ? `/${a.model}` : "";
      const snippet = a.content.replace(/\s+/g, " ").trim().slice(0, 220);
      return `${who}${mod}: ${snippet}${a.content.length > 220 ? "…" : ""}`;
    });

    const bullet = `- **Topic:** ${q}${answerSummaries.length ? `\n  ${answerSummaries.join("\n  ")}` : ""}`;
    if (bullet.length > remaining) {
      if (lines.length === 0 && remaining > 120) {
        lines.push(bullet.slice(0, remaining - 4) + "…");
      }
      break;
    }
    lines.push(bullet);
    remaining -= bullet.length + 1;
  }

  return lines.join("\n");
}

export interface ContextBuildStats {
  hasSummary: boolean;
  summarizedMessages: number;
  includedTurns: number;
  overflowDigestedTurns: number;
  foldedDiscussions: number;
  contextChars: number;
  estimatedTokens: number;
  transcriptPath?: string;
}

export function buildSharedContextBlock(opts: {
  history: ChatMessage[];
  targetAgent: AgentId;
  config: Pick<McliConfig, "shareContext" | "maxContextTurns" | "maxContextChars">;
  sessionSummary?: string;
  summarizedUpTo?: number;
  transcriptPath?: string;
}): { contextBlock: string; stats: ContextBuildStats } {
  const emptyStats: ContextBuildStats = {
    hasSummary: Boolean(opts.sessionSummary?.trim()),
    summarizedMessages: opts.summarizedUpTo ?? 0,
    includedTurns: 0,
    overflowDigestedTurns: 0,
    foldedDiscussions: 0,
    contextChars: 0,
    estimatedTokens: 0,
    transcriptPath: opts.transcriptPath,
  };

  if (!opts.config.shareContext) {
    return { contextBlock: "", stats: emptyStats };
  }

  const startIndex = Math.max(0, Math.min(opts.summarizedUpTo ?? 0, opts.history.length));
  const unsummarized = opts.history.slice(startIndex);
  const allGroups = groupMessagesIntoTurns(unsummarized);
  const hasSavedSummary = Boolean(opts.sessionSummary && opts.sessionSummary.trim().length > 0);

  if (allGroups.length === 0 && !hasSavedSummary) {
    return { contextBlock: "", stats: emptyStats };
  }

  const maxTurns = Math.max(1, opts.config.maxContextTurns);
  const olderByTurnLimit =
    allGroups.length > maxTurns ? allGroups.slice(0, allGroups.length - maxTurns) : [];
  const candidateGroups = allGroups.slice(-maxTurns);

  let charBudget = opts.config.maxContextChars;
  const savedSummaryText = opts.sessionSummary?.trim() ?? "";
  if (savedSummaryText) {
    charBudget = Math.max(2000, charBudget - Math.min(savedSummaryText.length, 6000));
  }

  const formattedEntries: string[] = [];
  const overflowGroups: TurnGroup[] = [...olderByTurnLimit];
  let foldedDiscussions = 0;

  // Walk backwards from most recent turn so the latest turns always stay verbatim.
  for (let i = candidateGroups.length - 1; i >= 0; i--) {
    const isLatestTurn = i === candidateGroups.length - 1;
    const { text, folded } = formatTurnGroup(candidateGroups[i], {
      foldDiscussion: !isLatestTurn,
    });
    if (text.length > charBudget) {
      if (formattedEntries.length === 0 && charBudget > 300) {
        formattedEntries.unshift(text.slice(0, charBudget - 20) + "\n...[truncated]");
        if (folded) foldedDiscussions++;
      } else {
        overflowGroups.unshift(...candidateGroups.slice(0, i + 1));
      }
      break;
    }
    formattedEntries.unshift(text);
    if (folded) foldedDiscussions++;
    charBudget -= text.length + 2;
  }

  // Build deterministic overflow digest if any unsummarized turns exceeded budget
  const overflowMessages: ChatMessage[] = [];
  for (const g of overflowGroups) {
    if (g.user) overflowMessages.push(g.user);
    overflowMessages.push(...g.assistants);
  }
  const overflowDigest = overflowMessages.length > 0 ? buildLocalDigest(overflowMessages, 3200) : "";

  const targetLabel = AGENT_META[opts.targetAgent].label;
  const openTag = opts.transcriptPath
    ? `<shared_conversation_history transcript_file="${opts.transcriptPath}">`
    : `<shared_conversation_history>`;

  const sections: string[] = [
    openTag,
    `The user is chatting in a unified multi-agent CLI (mcli) and has now routed the next turn to ${targetLabel}.`,
    `Continue seamlessly from the shared conversation below without re-explaining this wrapper.`,
  ];

  if (opts.transcriptPath) {
    sections.push(
      `Full verbatim session log is persisted at: ${opts.transcriptPath} (read it if you need exact earlier details).`,
    );
  }

  if (savedSummaryText) {
    sections.push("", `<earlier_conversation_summary>`, savedSummaryText, `</earlier_conversation_summary>`);
  }

  if (overflowDigest) {
    sections.push(
      "",
      `<older_turns_digest count="${overflowGroups.length}">`,
      overflowDigest,
      `</older_turns_digest>`,
    );
  }

  if (formattedEntries.length > 0) {
    sections.push("", formattedEntries.join("\n\n"));
  }

  sections.push(`</shared_conversation_history>`);

  const contextBlock = sections.join("\n");

  return {
    contextBlock,
    stats: {
      hasSummary: hasSavedSummary || Boolean(overflowDigest),
      summarizedMessages: startIndex,
      includedTurns: formattedEntries.length,
      overflowDigestedTurns: overflowGroups.length,
      foldedDiscussions,
      contextChars: contextBlock.length,
      estimatedTokens: Math.ceil(contextBlock.length / 4),
      transcriptPath: opts.transcriptPath,
    },
  };
}

/**
 * Formats prior shared conversation history (Tier 1 rolling summary + Tier 2
 * folded discussions + Tier 3 transcript file pointer) so any agent receives
 * full awareness of what happened earlier in the conversation.
 */
export function buildPromptWithContext(opts: {
  userPrompt: string;
  history: ChatMessage[];
  targetAgent: AgentId;
  config: Pick<McliConfig, "shareContext" | "maxContextTurns" | "maxContextChars">;
  sessionSummary?: string;
  summarizedUpTo?: number;
  transcriptPath?: string;
}): string {
  const { contextBlock } = buildSharedContextBlock(opts);
  if (!contextBlock) {
    return opts.userPrompt;
  }
  return [contextBlock, "", `User's current request:`, opts.userPrompt].join("\n");
}

/**
 * Compacts older turns in `session` into `session.summary` (Tier 1 memory),
 * keeping the most recent `keepRecentTurns` turns verbatim.
 * Uses the provided agent adapter if available, or falls back to a fast local digest.
 */
export async function compactSession(opts: {
  session: SessionData;
  cwd: string;
  keepRecentTurns?: number;
  fast?: boolean;
  adapter?: AgentAdapter;
  agentConfig?: AgentConfig;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ compactedTurns: number; summary: string; mode: "agent" | "local" }> {
  const keepRecent = Math.max(0, opts.keepRecentTurns ?? 2);
  const startIdx = Math.max(0, Math.min(opts.session.summarizedUpTo ?? 0, opts.session.messages.length));

  // Find the index in session.messages where the last `keepRecent` user turns begin
  const userIndices: number[] = [];
  for (let i = startIdx; i < opts.session.messages.length; i++) {
    if (opts.session.messages[i].role === "user") {
      userIndices.push(i);
    }
  }

  const cutIndex =
    keepRecent === 0
      ? opts.session.messages.length
      : userIndices.length > keepRecent
        ? userIndices[userIndices.length - keepRecent]
        : startIdx;

  if (cutIndex <= startIdx) {
    return {
      compactedTurns: 0,
      summary: opts.session.summary ?? "",
      mode: "local",
    };
  }

  const toCompact = opts.session.messages.slice(startIdx, cutIndex);
  const compactedTurns = groupMessagesIntoTurns(toCompact).length;
  const localDigest = buildLocalDigest(toCompact, 5000);

  let nextSummary = opts.session.summary
    ? `${opts.session.summary.trim()}\n\n${localDigest}`
    : localDigest;
  let mode: "agent" | "local" = "local";

  if (!opts.fast && opts.adapter) {
    const groups = groupMessagesIntoTurns(toCompact);
    const rendered = groups
      .map((g) => formatTurnGroup(g, { foldDiscussion: true }).text)
      .join("\n\n")
      .slice(0, 20000);

    const summarizePrompt = [
      `Update the rolling shared memory summary for a multi-agent terminal session.`,
      `Keep it concise (under 350 words) using crisp bullet points covering:`,
      `- Core goal / topic`,
      `- Key conclusions & consensus reached (note which model/agent contributed key points)`,
      `- Important code changes, files, formulas, or facts established`,
      `- Open questions or next steps`,
      opts.session.summary ? `\nExisting summary:\n${opts.session.summary.trim()}` : "",
      `\nNew turns to fold into memory:\n${rendered}`,
    ]
      .filter(Boolean)
      .join("\n");

    const controller = new AbortController();
    const signal = opts.signal ?? controller.signal;
    try {
      const res = await opts.adapter.run({
        prompt: summarizePrompt,
        rawUserPrompt: summarizePrompt,
        history: [],
        cwd: opts.cwd,
        model: opts.model,
        config: opts.agentConfig ?? {},
        signal,
        onEvent: () => {
          // quiet background compaction
        },
      });
      if (!res.error && res.text.trim().length > 20) {
        nextSummary = res.text.trim();
        mode = "agent";
      }
    } catch {
      // fall back to local digest cleanly
    }
  }

  opts.session.summary = nextSummary;
  opts.session.summarizedUpTo = cutIndex;
  saveSession(opts.session);

  return { compactedTurns, summary: nextSummary, mode };
}

export function exportSessionMarkdown(session: SessionData): string {
  const lines: string[] = [
    `# mcli Session: ${session.name}`,
    ``,
    `- **Session ID:** \`${session.id}\``,
    `- **Working Directory:** \`${session.cwd}\``,
    `- **Created:** ${session.createdAt}`,
    `- **Updated:** ${session.updatedAt}`,
    ``,
  ];

  if (session.summary && session.summary.trim()) {
    lines.push(`## Rolling Memory Summary`);
    lines.push(``);
    lines.push(session.summary.trim());
    lines.push(``);
  }

  lines.push(`---`, ``);

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const target = msg.roundLabel
        ? ` → ${msg.roundLabel}`
        : msg.agent
          ? ` → \`--${msg.agent}\``
          : "";
      lines.push(`## User${target}`);
      lines.push(``);
      lines.push(msg.content);
      lines.push(``);
    } else if (msg.role === "assistant") {
      const label = msg.agent ? AGENT_META[msg.agent].label : "Assistant";
      const modelNote = msg.model ? ` (${msg.model})` : "";
      const roundNote = msg.roundLabel ? ` — ${msg.roundLabel}` : "";
      lines.push(`## ${label}${modelNote}${roundNote}`);
      lines.push(``);
      if (msg.tools && msg.tools.length > 0) {
        lines.push(
          `> Tools: ${msg.tools.map((t) => (t.detail ? `\`${t.name}: ${t.detail}\`` : `\`${t.name}\``)).join(", ")}`,
        );
        lines.push(``);
      }
      if (msg.reasoning && msg.reasoning.trim()) {
        lines.push(`<details><summary>Reasoning</summary>`);
        lines.push(``);
        lines.push(msg.reasoning.trim());
        lines.push(``);
        lines.push(`</details>`);
        lines.push(``);
      }
      if (msg.content) {
        lines.push(msg.content);
        lines.push(``);
      }
      if (msg.error) {
        lines.push(`> **Error:** ${msg.error}`);
        lines.push(``);
      }
    }
  }

  return lines.join("\n");
}
