import { spawnSync } from "node:child_process";
import { AGENT_META } from "../types.ts";
import type { AgentId } from "../types.ts";

const ESC = "\x1b[";

export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const ITALIC = `${ESC}3m`;
export const UNDERLINE = `${ESC}4m`;
export const INVERSE = `${ESC}7m`;

export const FG = {
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  brightRed: `${ESC}91m`,
  brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`,
  brightBlue: `${ESC}94m`,
  brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`,
  brightWhite: `${ESC}97m`,
  orange: `${ESC}38;5;208m`,
} as const;

export const BG = {
  orange: `${ESC}48;5;208m`,
  green: `${ESC}42m`,
  cyan: `${ESC}46m`,
  magenta: `${ESC}45m`,
  yellow: `${ESC}43m`,
  darkGray: `${ESC}48;5;236m`,
  slate: `${ESC}48;5;235m`,
} as const;

export function agentFg(agent: AgentId): string {
  const color = AGENT_META[agent].color;
  switch (color) {
    case "orange":
      return FG.orange;
    case "green":
      return FG.brightGreen;
    case "cyan":
      return FG.brightCyan;
    case "magenta":
      return FG.brightMagenta;
    case "yellow":
      return FG.brightYellow;
  }
}

export function agentBg(agent: AgentId): string {
  const color = AGENT_META[agent].color;
  switch (color) {
    case "orange":
      return BG.orange;
    case "green":
      return BG.green;
    case "cyan":
      return BG.cyan;
    case "magenta":
      return BG.magenta;
    case "yellow":
      return BG.yellow;
  }
}

export function style(text: string, ...codes: string[]): string {
  if (!text) return "";
  return `${codes.join("")}${text}${RESET}`;
}

export function agentBadge(agent: AgentId, active = false): string {
  const label = AGENT_META[agent].label;
  if (active) {
    return `${agentBg(agent)}${FG.black}${BOLD} ${label} ${RESET}`;
  }
  return `${agentFg(agent)}${BOLD}${label}${RESET}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function padRightVisible(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

export function truncateVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLength(text) <= maxWidth) return text;

  let out = "";
  let vis = 0;
  let i = 0;
  const target = Math.max(0, maxWidth - 1);

  while (i < text.length && vis < target) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const match = text.slice(i).match(/^\x1b\[[0-9;?]*[a-zA-Z]/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += text[i];
    vis++;
    i++;
  }

  return `${out}…${RESET}`;
}

/**
 * Wraps plain text (no ANSI sequences) into lines of at most `width` columns.
 */
export function wrapPlainText(text: string, width: number): string[] {
  const maxWidth = Math.max(8, width);
  const inputLines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  for (const rawLine of inputLines) {
    if (rawLine.length <= maxWidth) {
      out.push(rawLine);
      continue;
    }

    let remaining = rawLine;
    while (remaining.length > maxWidth) {
      let breakAt = remaining.lastIndexOf(" ", maxWidth);
      if (breakAt <= Math.floor(maxWidth * 0.35)) {
        breakAt = maxWidth;
      }
      out.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).replace(/^ +/, "");
    }
    if (remaining.length > 0 || rawLine.length === 0) {
      out.push(remaining);
    }
  }

  return out;
}

function formatInlineMarkdown(line: string): string {
  // Inline code: `code`
  let formatted = line.replace(/`([^`]+)`/g, (_m, code: string) =>
    style(` ${code} `, BG.darkGray, FG.brightWhite),
  );
  // Bold: **text**
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) =>
    style(inner, BOLD, FG.brightWhite),
  );
  return formatted;
}

/**
 * Renders Markdown text into width-constrained ANSI-styled terminal lines.
 */
export function renderMarkdownLines(
  markdown: string,
  width: number,
  indent = "  ",
): string[] {
  const innerWidth = Math.max(12, width - indent.length);
  const rawLines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";

  for (const rawLine of rawLines) {
    const fenceMatch = rawLine.match(/^\s*```(\S*)\s*$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] || "code";
        const header = `╭─ ${codeLang} `;
        const bar = "─".repeat(Math.max(0, innerWidth - header.length));
        out.push(indent + style(header + bar, DIM, FG.cyan));
      } else {
        inCodeBlock = false;
        codeLang = "";
        out.push(indent + style("╰" + "─".repeat(Math.max(1, innerWidth - 1)), DIM, FG.cyan));
      }
      continue;
    }

    if (inCodeBlock) {
      const wrapped = wrapPlainText(rawLine, Math.max(8, innerWidth - 2));
      for (const wl of wrapped) {
        out.push(indent + style("│ ", DIM, FG.cyan) + style(wl, FG.brightWhite));
      }
      continue;
    }

    // Headings
    const headingMatch = rawLine.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const title = headingMatch[2];
      for (const wl of wrapPlainText(title, innerWidth)) {
        out.push(indent + style(wl, BOLD, UNDERLINE, FG.brightWhite));
      }
      continue;
    }

    // Blockquotes
    const quoteMatch = rawLine.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      for (const wl of wrapPlainText(quoteMatch[1], Math.max(8, innerWidth - 2))) {
        out.push(indent + style("│ ", FG.gray) + style(formatInlineMarkdown(wl), DIM, ITALIC));
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_]){3,}\s*$/.test(rawLine)) {
      out.push(indent + style("─".repeat(Math.min(innerWidth, 60)), DIM, FG.gray));
      continue;
    }

    // Bullet lists
    const bulletMatch = rawLine.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bulletMatch) {
      const lead = bulletMatch[1];
      const prefix = `${lead}• `;
      const wrapped = wrapPlainText(bulletMatch[2], Math.max(8, innerWidth - prefix.length));
      wrapped.forEach((wl, idx) => {
        const marker = idx === 0 ? style(prefix, FG.cyan) : " ".repeat(prefix.length);
        out.push(indent + marker + formatInlineMarkdown(wl));
      });
      continue;
    }

    // Blank line
    if (!rawLine.trim()) {
      out.push("");
      continue;
    }

    // Regular paragraph line
    for (const wl of wrapPlainText(rawLine, innerWidth)) {
      out.push(indent + formatInlineMarkdown(wl));
    }
  }

  return out;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return `${mins}m ${rem}s`;
}

export function copyToClipboard(text: string): boolean {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ];

  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { input: text, encoding: "utf8" });
    if (!res.error && res.status === 0) {
      return true;
    }
  }
  return false;
}
