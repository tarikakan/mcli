import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSessionsDir } from "./config.ts";
import { AGENT_META } from "./types.ts";
import type { AgentId, ChatMessage, McliConfig, SessionData } from "./types.ts";

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

export function saveSession(session: SessionData): string {
  session.updatedAt = new Date().toISOString();
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getSessionFilePath(session.id);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
  return filePath;
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

/**
 * Formats prior shared conversation history so any agent (claude, codex, agy,
 * deepseek, kimi) receives full context from previous turns — even when
 * switching seamlessly from one agent to another.
 */
export function buildPromptWithContext(opts: {
  userPrompt: string;
  history: ChatMessage[];
  targetAgent: AgentId;
  config: Pick<McliConfig, "shareContext" | "maxContextTurns" | "maxContextChars">;
}): string {
  if (!opts.config.shareContext) {
    return opts.userPrompt;
  }

  const relevant = opts.history.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0,
  );

  if (relevant.length === 0) {
    return opts.userPrompt;
  }

  const maxMessages = Math.max(2, opts.config.maxContextTurns * 2);
  const recent = relevant.slice(-maxMessages);

  const formattedEntries: string[] = [];
  let charBudget = opts.config.maxContextChars;

  // Walk backwards so the most recent turns are always preserved within budget.
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    const speaker =
      msg.role === "user"
        ? "User"
        : `Assistant (${msg.agent ? AGENT_META[msg.agent].label : "agent"}${msg.model ? ` / ${msg.model}` : ""}${msg.roundLabel ? ` · ${msg.roundLabel}` : ""})`;

    let body = msg.content.trim();
    if (msg.tools && msg.tools.length > 0) {
      const toolSummary = msg.tools
        .slice(0, 6)
        .map((t) => (t.detail ? `${t.name}(${t.detail})` : t.name))
        .join(", ");
      body = `[Tools used: ${toolSummary}]\n${body}`;
    }

    const entry = `### ${speaker}\n${body}`;
    if (entry.length > charBudget) {
      if (formattedEntries.length === 0 && charBudget > 200) {
        formattedEntries.unshift(entry.slice(0, charBudget - 20) + "\n...[truncated]");
      }
      break;
    }
    formattedEntries.unshift(entry);
    charBudget -= entry.length + 2;
  }

  if (formattedEntries.length === 0) {
    return opts.userPrompt;
  }

  const targetLabel = AGENT_META[opts.targetAgent].label;
  return [
    `<shared_conversation_history>`,
    `The user is chatting in a unified multi-agent CLI (mcli) and has now routed the next turn to ${targetLabel}.`,
    `Continue seamlessly from the shared conversation below without re-explaining this wrapper.`,
    ``,
    formattedEntries.join("\n\n"),
    `</shared_conversation_history>`,
    ``,
    `User's current request:`,
    opts.userPrompt,
  ].join("\n");
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
    `---`,
    ``,
  ];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const target = msg.agent ? ` → \`--${msg.agent}\`` : "";
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
