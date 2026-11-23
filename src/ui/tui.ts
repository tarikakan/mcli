import fs from "node:fs";
import path from "node:path";
import { detectAllAgents, getAdapter } from "../adapters/index.ts";
import { isAgentId, parseInlineInput } from "../cli-args.ts";
import { getConfigPath, saveConfig } from "../config.ts";
import { runAgentDiscussion } from "../discussion.ts";
import {
  getEffectiveContextConfig,
  resolveMemoryScribe,
  runMemoryScribe,
  shouldAutoCompact,
} from "../memory-agent.ts";
import {
  discoverAllAgentModels,
  discoverModelsForAgent,
  getModelsForAgent,
  resolveModelAlias,
} from "../models.ts";
import type { ModelOption } from "../models.ts";
import {
  buildPromptWithContext,
  buildSharedContextBlock,
  createMessageId,
  exportSessionMarkdown,
  getSessionTranscriptPath,
  listSessions,
  loadOrCreateSession,
  saveSession,
  saveSessionAs,
} from "../session.ts";
import {
  buildSkillsPromptBlock,
  discoverSkills,
  prependSkillsToPrompt,
  resolveRequestedSkills,
} from "../skills.ts";
import type { SkillInfo } from "../skills.ts";
import { AGENT_IDS, AGENT_META, formatTargetLabel } from "../types.ts";
import type {
  AgentAvailability,
  AgentId,
  AgentTarget,
  ChatMessage,
  McliConfig,
  SessionData,
  ToolEvent,
} from "../types.ts";
import {
  BG,
  BOLD,
  DIM,
  FG,
  ITALIC,
  RESET,
  agentBadge,
  agentBg,
  agentFg,
  copyToClipboard,
  extractSelectionText,
  findWordBounds,
  formatDuration,
  highlightVisibleRange,
  normalizeSelection,
  padRightVisible,
  readFromClipboard,
  renderMarkdownLines,
  stripAnsi,
  style,
  truncateVisible,
  wrapPlainText,
  writeOsc52Clipboard,
} from "./ansi.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/agents",
  "/skills",
  "/skill",
  "/clear",
  "/compact",
  "/memory",
  "/history",
  "/context",
  "/discuss",
  "/model",
  "/models",
  "/mouse",
  "/session",
  "/copy",
  "/export",
  "/config",
  "/exit",
];

export interface ParsedMouseSequence {
  length: number;
  wheel?: "up" | "down";
  kind?: "press" | "drag" | "release";
  button?: number;
  col?: number;
  row?: number;
}

/**
 * Parses SGR (\x1b[<b;x;yM / m) and legacy X10 (\x1b[Mbxy) terminal mouse
 * sequences at the start of `rest`. Returns consumed length, wheel direction,
 * and click/drag/release coordinates (1-based col & row).
 */
export function parseMouseSequence(rest: string): ParsedMouseSequence | undefined {
  // SGR mouse protocol: ESC [ < Cb ; Cx ; Cy (M|m)
  const sgr = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgr) {
    const cb = Number.parseInt(sgr[1], 10);
    const col = Number.parseInt(sgr[2], 10);
    const row = Number.parseInt(sgr[3], 10);
    const terminator = sgr[4];

    if (terminator === "M" && (cb & 64) !== 0) {
      const dir = cb & 3;
      if (dir === 0) return { length: sgr[0].length, wheel: "up", col, row };
      if (dir === 1) return { length: sgr[0].length, wheel: "down", col, row };
      return { length: sgr[0].length, col, row };
    }

    const button = cb & 3;
    if (terminator === "m") {
      return { length: sgr[0].length, kind: "release", button, col, row };
    }
    if ((cb & 32) !== 0) {
      return { length: sgr[0].length, kind: "drag", button, col, row };
    }
    return { length: sgr[0].length, kind: "press", button, col, row };
  }

  // Legacy X10 mouse protocol: ESC [ M Cb Cx Cy (6 chars total)
  if (rest.startsWith("\x1b[M") && rest.length >= 6) {
    const cb = rest.charCodeAt(3) - 32;
    const col = rest.charCodeAt(4) - 32;
    const row = rest.charCodeAt(5) - 32;
    if ((cb & 64) !== 0) {
      const dir = cb & 3;
      if (dir === 0) return { length: 6, wheel: "up", col, row };
      if (dir === 1) return { length: 6, wheel: "down", col, row };
    }
    const button = cb & 3;
    if (button === 3) {
      return { length: 6, kind: "release", button: 0, col, row };
    }
    if ((cb & 32) !== 0) {
      return { length: 6, kind: "drag", button, col, row };
    }
    return { length: 6, kind: "press", button, col, row };
  }

  return undefined;
}

interface LiveStream {
  agent: AgentId;
  model?: string;
  roundLabel?: string;
  text: string;
  reasoning: string;
  tools: ToolEvent[];
  error?: string;
  startedAt: number;
  done: boolean;
}

export interface TuiOptions {
  config: McliConfig;
  session: SessionData;
  cwd: string;
  initialAgent: AgentId;
  modelOverride?: string;
  agentModels?: Partial<Record<AgentId, string>>;
  agentDiscussion?: boolean;
  discussionRounds?: number;
}

interface ModelPickerState {
  agent: AgentId;
  items: Array<{ id?: string; label: string; note?: string }>;
  selectedIndex: number;
}

export class UnifiedChatTui {
  private config: McliConfig;
  private session: SessionData;
  private cwd: string;
  private activeAgent: AgentId;
  private availability: Record<AgentId, AgentAvailability>;
  private modelOverrides: Partial<Record<AgentId, string>> = {};
  private shareContext: boolean;
  private agentDiscussion: boolean;
  private discussionRounds: number;

  private input = "";
  private cursor = 0;
  private promptHistory: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";

  private scrollOffset = 0; // 0 = pinned to bottom; >0 = scrolled up by N lines
  private lastTotalLines = 0;
  private lastViewportHeight = 10;
  private lastHeaderHeight = 3;
  private lastStartIdx = 0;
  private lastPlainLines: string[] = [];
  private lastInputRowIndex = 23;
  private lastInputPrefixLen = 12;
  private lastInputWindowStart = 0;

  private selection: {
    anchorLine: number;
    anchorCol: number;
    focusLine: number;
    focusCol: number;
  } | null = null;
  private isDraggingSelection = false;
  private lastClickAt = 0;
  private lastClickLine = -1;
  private lastClickCol = -1;
  private clickCount = 0;

  private inBracketedPaste = false;
  private pasteBuffer = "";

  private activeController: AbortController | null = null;
  private liveStreams: LiveStream[] = [];
  private spinnerIdx = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;

  private notice = "";
  private noticeExpiresAt = 0;
  private lastCtrlCAt = 0;
  private mouseEnabled = true;
  private memoryCompacting = false;
  private availableSkills: SkillInfo[] = [];
  private modelPicker: ModelPickerState | null = null;
  private renderScheduled = false;
  private running = false;
  private resolveExit: (() => void) | null = null;

  constructor(opts: TuiOptions) {
    this.config = opts.config;
    this.session = opts.session;
    this.cwd = opts.cwd;
    this.activeAgent = opts.initialAgent;
    this.shareContext = opts.config.shareContext;
    this.agentDiscussion = opts.agentDiscussion ?? opts.config.agentDiscussion;
    this.discussionRounds = opts.discussionRounds ?? opts.config.discussionRounds;
    this.availability = detectAllAgents(opts.config);
    this.availableSkills = discoverSkills(opts.cwd, opts.config);
    if (opts.agentModels) {
      this.modelOverrides = { ...opts.agentModels };
    }
    if (opts.modelOverride) {
      this.modelOverrides[this.activeAgent] = resolveModelAlias(this.activeAgent, opts.modelOverride);
    }
    this.promptHistory = opts.session.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);
  }

  public async start(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("TUI requires an interactive TTY.");
    }

    this.running = true;
    this.enterAltScreen();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (chunk: string): void => this.handleInputChunk(chunk);
    const onResize = (): void => this.scheduleRender();
    const onExitSignal = (): void => this.shutdown();

    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    process.on("SIGTERM", onExitSignal);
    process.on("SIGHUP", onExitSignal);

    this.render();

    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", onExitSignal);
    process.off("SIGHUP", onExitSignal);
  }

  private setMouseTracking(enabled: boolean): void {
    this.mouseEnabled = enabled;
    if (enabled) {
      // Enable click/wheel + button-drag tracking + SGR extended coordinates
      process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    } else {
      process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
    }
  }

  private enterAltScreen(): void {
    // Alternate screen + bracketed paste mode (\x1b[?2004h)
    process.stdout.write("\x1b[?1049h\x1b[?2004h\x1b[?25h\x1b[2J\x1b[H");
    this.setMouseTracking(this.mouseEnabled);
  }

  private leaveAltScreen(): void {
    process.stdout.write("\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  }

  private insertTextAtCursor(rawText: string, announcePaste = false): void {
    // Normalize pasted line endings so multi-line pastes insert cleanly without auto-submitting
    const sanitized = rawText
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n+/g, " ")
      .replace(/\t/g, "  ");
    if (!sanitized) return;

    this.selection = null;
    this.input = this.input.slice(0, this.cursor) + sanitized + this.input.slice(this.cursor);
    this.cursor += sanitized.length;
    this.historyIndex = -1;

    if (announcePaste && sanitized.length > 0) {
      this.setNotice(`Pasted ${sanitized.length} char${sanitized.length === 1 ? "" : "s"}.`, 2200);
    } else {
      this.scheduleRender();
    }
  }

  private copySelectedText(silentIfEmpty = false): boolean {
    if (!this.selection) return false;
    const norm = normalizeSelection(this.selection);
    const text = extractSelectionText(this.lastPlainLines, norm);
    if (!text) {
      if (!silentIfEmpty) this.setNotice("Selection is empty.", 1800);
      return false;
    }

    const copied = copyToClipboard(text);
    writeOsc52Clipboard(text);
    const linesCount = text.split("\n").length;
    const summary =
      linesCount > 1
        ? `${text.length} chars (${linesCount} lines)`
        : `${text.length} char${text.length === 1 ? "" : "s"}`;
    this.setNotice(
      copied
        ? `Copied ${summary} to clipboard (Cmd+V / Ctrl+V to paste).`
        : `Sent ${summary} via OSC 52 clipboard.`,
      2800,
    );
    return true;
  }

  private screenToContentPos(col1: number, row1: number): { line: number; col: number } | undefined {
    if (this.lastPlainLines.length === 0) return undefined;
    const viewportRow = row1 - this.lastHeaderHeight - 1; // 0-based inside viewport
    const clampedViewportRow = Math.max(0, Math.min(this.lastViewportHeight - 1, viewportRow));
    const lineIdx = Math.max(
      0,
      Math.min(this.lastPlainLines.length - 1, this.lastStartIdx + clampedViewportRow),
    );
    const lineLen = this.lastPlainLines[lineIdx]?.length ?? 0;
    const col0 = Math.max(0, Math.min(Math.max(0, lineLen - 1), col1 - 1));
    return { line: lineIdx, col: col0 };
  }

  private handleMouseEvent(mouse: ParsedMouseSequence): void {
    if (mouse.wheel === "up") {
      this.scrollChat(3);
      return;
    }
    if (mouse.wheel === "down") {
      this.scrollChat(-3);
      return;
    }

    const col = mouse.col ?? 1;
    const row = mouse.row ?? 1;

    // Left-click inside the input box moves the text cursor there
    if (mouse.kind === "press" && mouse.button === 0 && row === this.lastInputRowIndex) {
      this.selection = null;
      this.isDraggingSelection = false;
      const relCol = col - 1 - this.lastInputPrefixLen;
      this.cursor = Math.max(0, Math.min(this.input.length, this.lastInputWindowStart + relCol));
      this.scheduleRender();
      return;
    }

    // Middle-click pastes from clipboard (classic Unix terminal convenience)
    if (mouse.kind === "press" && mouse.button === 1) {
      const clip = readFromClipboard();
      if (clip) this.insertTextAtCursor(clip, true);
      return;
    }

    const inViewport =
      row > this.lastHeaderHeight && row <= this.lastHeaderHeight + this.lastViewportHeight;

    if (mouse.kind === "press" && mouse.button === 0) {
      if (!inViewport) {
        if (this.selection) {
          this.selection = null;
          this.scheduleRender();
        }
        return;
      }

      const pos = this.screenToContentPos(col, row);
      if (!pos) return;

      const now = Date.now();
      const sameSpot =
        now - this.lastClickAt < 450 &&
        pos.line === this.lastClickLine &&
        Math.abs(pos.col - this.lastClickCol) <= 2;
      this.clickCount = sameSpot ? Math.min(3, this.clickCount + 1) : 1;
      this.lastClickAt = now;
      this.lastClickLine = pos.line;
      this.lastClickCol = pos.col;

      if (this.clickCount === 2) {
        // Double-click: select whole word and copy immediately
        const lineText = this.lastPlainLines[pos.line] ?? "";
        const bounds = findWordBounds(lineText, pos.col);
        if (bounds) {
          this.selection = {
            anchorLine: pos.line,
            anchorCol: bounds.start,
            focusLine: pos.line,
            focusCol: bounds.end,
          };
          this.isDraggingSelection = false;
          this.copySelectedText(true);
          this.scheduleRender();
          return;
        }
      } else if (this.clickCount === 3) {
        // Triple-click: select entire trimmed line and copy immediately
        const lineText = this.lastPlainLines[pos.line] ?? "";
        const trimmedStart = lineText.search(/\S/);
        const trimmedEnd = lineText.trimEnd().length - 1;
        if (trimmedStart !== -1 && trimmedEnd >= trimmedStart) {
          this.selection = {
            anchorLine: pos.line,
            anchorCol: trimmedStart,
            focusLine: pos.line,
            focusCol: trimmedEnd,
          };
          this.isDraggingSelection = false;
          this.copySelectedText(true);
          this.scheduleRender();
          return;
        }
      }

      // Single press: start drag selection
      this.isDraggingSelection = true;
      this.selection = {
        anchorLine: pos.line,
        anchorCol: pos.col,
        focusLine: pos.line,
        focusCol: pos.col,
      };
      this.scheduleRender();
      return;
    }

    if (mouse.kind === "drag" && mouse.button === 0 && this.isDraggingSelection && this.selection) {
      if (row <= this.lastHeaderHeight) {
        this.scrollChat(1);
      } else if (row > this.lastHeaderHeight + this.lastViewportHeight) {
        this.scrollChat(-1);
      }
      const pos = this.screenToContentPos(col, row);
      if (pos) {
        this.selection.focusLine = pos.line;
        this.selection.focusCol = pos.col;
        this.scheduleRender();
      }
      return;
    }

    if (mouse.kind === "release" && this.isDraggingSelection) {
      this.isDraggingSelection = false;
      if (this.selection) {
        const pos = this.screenToContentPos(col, row);
        if (pos) {
          this.selection.focusLine = pos.line;
          this.selection.focusCol = pos.col;
        }
        const singleCharClick =
          this.selection.anchorLine === this.selection.focusLine &&
          this.selection.anchorCol === this.selection.focusCol;
        if (singleCharClick) {
          // Plain single click without dragging clears highlight
          this.selection = null;
        } else {
          this.copySelectedText(true);
        }
        this.scheduleRender();
      }
    }
  }

  private scrollChat(deltaLines: number): void {
    const maxScroll = Math.max(0, this.lastTotalLines - this.lastViewportHeight);
    const next = Math.max(0, Math.min(maxScroll, this.scrollOffset + deltaLines));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.scheduleRender();
    }
  }

  private shutdown(): void {
    if (!this.running) return;
    this.running = false;
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    try {
      saveSession(this.session);
    } catch {
      // ignore save error on exit
    }
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      // ignore
    }
    this.leaveAltScreen();
    if (this.resolveExit) {
      const done = this.resolveExit;
      this.resolveExit = null;
      done();
    }
  }

  private setNotice(text: string, durationMs = 3500): void {
    this.notice = text;
    this.noticeExpiresAt = Date.now() + durationMs;
    this.scheduleRender();
  }

  private addSystemMessage(content: string): void {
    this.session.messages.push({
      id: createMessageId(),
      role: "system",
      content,
      timestamp: new Date().toISOString(),
    });
    this.scrollOffset = 0;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (!this.running || this.renderScheduled) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      if (this.running) {
        this.render();
      }
    });
  }

  private cycleAgent(delta: 1 | -1): void {
    const idx = AGENT_IDS.indexOf(this.activeAgent);
    const next = AGENT_IDS[(idx + delta + AGENT_IDS.length) % AGENT_IDS.length];
    this.activeAgent = next;
    this.session.activeAgent = next;
    this.setNotice(`Switched active agent to --${next} (${AGENT_META[next].label})`, 2200);
  }

  private getAutocompleteSuggestion(): string | undefined {
    const beforeCursor = this.input.slice(0, this.cursor);
    if (!beforeCursor || this.cursor !== this.input.length) return undefined;

    if (beforeCursor.startsWith("/") && !beforeCursor.includes(" ")) {
      return SLASH_COMMANDS.find((c) => c.startsWith(beforeCursor) && c !== beforeCursor);
    }

    const dollarMatch = beforeCursor.match(/(?:^|\s)(\$[a-zA-Z0-9._-]*)$/);
    if (dollarMatch) {
      const prefix = dollarMatch[1];
      const partial = prefix.slice(1).toLowerCase();
      const matched = this.availableSkills.find(
        (s) => s.name.toLowerCase().startsWith(partial) && s.name.toLowerCase() !== partial,
      );
      if (matched) {
        return beforeCursor.slice(0, beforeCursor.length - prefix.length) + "$" + matched.name + " ";
      }
    }

    const tokenMatch = beforeCursor.match(/(?:^|\s)((?:--|@)[a-zA-Z]*)$/);
    if (tokenMatch) {
      const prefix = tokenMatch[1];
      const lead = prefix.startsWith("--") ? "--" : "@";
      const partial = prefix.slice(lead.length).toLowerCase();
      const candidates =
        lead === "--"
          ? [...AGENT_IDS, "models", "model", "skills", "skill", "discuss", "agent-discussion", "rounds"]
          : [...AGENT_IDS];
      const matched = candidates.find((id) => id.startsWith(partial) && id !== partial);
      if (matched) {
        return beforeCursor.slice(0, beforeCursor.length - prefix.length) + lead + matched + " ";
      }
    }

    return undefined;
  }

  private buildPickerItems(agent: AgentId, models: ModelOption[]): ModelPickerState["items"] {
    const current = this.modelOverrides[agent] ?? this.config.agents[agent]?.model;
    const items: ModelPickerState["items"] = [
      { id: undefined, label: "(CLI default)", note: "Use the agent CLI's own configured default" },
      ...models.map((m) => ({
        id: m.id,
        label: m.id,
        note: m.source === "discovered" && m.note ? `[live] ${m.note}` : m.note,
      })),
    ];
    if (current && !items.some((it) => it.id === current)) {
      items.splice(1, 0, { id: current, label: current, note: "Active session override" });
    }
    return items;
  }

  private openModelPicker(agent: AgentId = this.activeAgent): void {
    const initialModels = getModelsForAgent(agent, this.config.agents[agent] ?? {});
    const current = this.modelOverrides[agent] ?? this.config.agents[agent]?.model;
    const items = this.buildPickerItems(agent, initialModels);
    const idx = Math.max(
      0,
      items.findIndex((it) => it.id === current),
    );
    this.modelPicker = { agent, items, selectedIndex: idx };
    this.scheduleRender();

    // Refresh asynchronously from live CLI / API sources without blocking UI
    void discoverModelsForAgent(agent, this.config.agents[agent] ?? {}, true).then((fresh) => {
      if (!this.modelPicker || this.modelPicker.agent !== agent) return;
      const selectedId = this.modelPicker.items[this.modelPicker.selectedIndex]?.id;
      const updated = this.buildPickerItems(agent, fresh);
      const nextIdx = Math.max(
        0,
        updated.findIndex((it) => it.id === selectedId),
      );
      this.modelPicker = { agent, items: updated, selectedIndex: nextIdx };
      this.scheduleRender();
    });
  }

  private async showAllModelsInChat(filterAgents?: AgentId[]): Promise<void> {
    const targets = filterAgents && filterAgents.length > 0 ? filterAgents : [...AGENT_IDS];
    this.setNotice(
      `Fetching model list for ${targets.length === AGENT_IDS.length ? "all CLIs" : targets.map((a) => `--${a}`).join(", ")}…`,
      3000,
    );
    const allModels = await discoverAllAgentModels(this.config, {
      agents: targets,
      forceRefresh: true,
    });
    const lines: string[] = [
      `**Models across ${targets.length === AGENT_IDS.length ? "all 5 CLIs" : targets.map((a) => AGENT_META[a].label).join(", ")}:**`,
      "",
    ];
    for (const id of targets) {
      const active = this.modelOverrides[id] ?? this.config.agents[id]?.model;
      const activeTag = active ? ` *(active: \`${active}\`)*` : " *(CLI default)*";
      lines.push(`### ${AGENT_META[id].label} (\`--${id}\`)${activeTag}`);
      for (const m of allModels[id]) {
        const badge = m.source === "discovered" ? " **[live]**" : m.source === "config" ? " **[config]**" : "";
        const note = m.note ? ` — ${m.note}` : "";
        lines.push(`- \`${m.id}\`${badge}${note}`);
      }
      lines.push("");
    }
    lines.push("Tip: Use `--claude:opus <prompt>`, `/model <name>`, or press `Ctrl+O` for the interactive picker.");
    this.addSystemMessage(lines.join("\n"));
  }

  private applyModelPickerSelection(persist: boolean): void {
    if (!this.modelPicker) return;
    const { agent, items, selectedIndex } = this.modelPicker;
    const chosen = items[selectedIndex];
    if (!chosen) return;

    if (chosen.id === undefined) {
      delete this.modelOverrides[agent];
      if (persist) {
        this.config.agents[agent] = { ...this.config.agents[agent], model: undefined };
        saveConfig(this.config);
        this.setNotice(`Reset --${agent} to CLI default and saved to ~/.mcli/config.json.`);
      } else {
        this.setNotice(`Reset --${agent} to CLI default for this session.`);
      }
    } else {
      this.modelOverrides[agent] = chosen.id;
      if (persist) {
        this.config.agents[agent] = { ...this.config.agents[agent], model: chosen.id };
        saveConfig(this.config);
        this.setNotice(`Set --${agent} model to "${chosen.id}" and saved to ~/.mcli/config.json.`);
      } else {
        this.setNotice(`Set --${agent} model to "${chosen.id}" (press S in picker or /model save to persist).`);
      }
    }

    this.activeAgent = agent;
    this.session.activeAgent = agent;
    this.modelPicker = null;
    this.scheduleRender();
  }

  private handleModelPickerChunk(chunk: string): void {
    if (!this.modelPicker) return;

    if (parseMouseSequence(chunk)) {
      let i = 0;
      let changed = false;
      while (i < chunk.length) {
        const mouse = parseMouseSequence(chunk.slice(i));
        if (!mouse) break;
        const len = this.modelPicker.items.length;
        if (mouse.wheel === "up") {
          this.modelPicker.selectedIndex = (this.modelPicker.selectedIndex - 1 + len) % len;
          changed = true;
        } else if (mouse.wheel === "down") {
          this.modelPicker.selectedIndex = (this.modelPicker.selectedIndex + 1) % len;
          changed = true;
        }
        i += mouse.length;
      }
      if (changed) this.scheduleRender();
      return;
    }

    if (chunk === "\x1b" || chunk === "q" || chunk === "\x0f" || chunk === "\x03") {
      this.modelPicker = null;
      this.scheduleRender();
      return;
    }

    if (chunk === "\x1b[A" || chunk === "k") {
      const len = this.modelPicker.items.length;
      this.modelPicker.selectedIndex = (this.modelPicker.selectedIndex - 1 + len) % len;
      this.scheduleRender();
      return;
    }

    if (chunk === "\x1b[B" || chunk === "j") {
      const len = this.modelPicker.items.length;
      this.modelPicker.selectedIndex = (this.modelPicker.selectedIndex + 1) % len;
      this.scheduleRender();
      return;
    }

    if (chunk === "\t" || chunk === "\x1b[C" || chunk === "l") {
      const idx = AGENT_IDS.indexOf(this.modelPicker.agent);
      const next = AGENT_IDS[(idx + 1) % AGENT_IDS.length];
      this.openModelPicker(next);
      return;
    }

    if (chunk === "\x1b[Z" || chunk === "\x1b[D" || chunk === "h") {
      const idx = AGENT_IDS.indexOf(this.modelPicker.agent);
      const prev = AGENT_IDS[(idx - 1 + AGENT_IDS.length) % AGENT_IDS.length];
      this.openModelPicker(prev);
      return;
    }

    if (chunk === "\r" || chunk === "\n") {
      this.applyModelPickerSelection(false);
      return;
    }

    if (chunk === "s" || chunk === "S") {
      this.applyModelPickerSelection(true);
      return;
    }
  }

  private handleInputChunk(chunk: string): void {
    if (this.modelPicker) {
      this.handleModelPickerChunk(chunk);
      return;
    }

    let i = 0;
    while (i < chunk.length) {
      // Inside a bracketed paste (\x1b[200~ ... \x1b[201~): collect everything verbatim until end marker
      if (this.inBracketedPaste) {
        const endIdx = chunk.indexOf("\x1b[201~", i);
        if (endIdx === -1) {
          this.pasteBuffer += chunk.slice(i);
          return;
        }
        this.pasteBuffer += chunk.slice(i, endIdx);
        const pasted = this.pasteBuffer;
        this.pasteBuffer = "";
        this.inBracketedPaste = false;
        this.insertTextAtCursor(pasted, true);
        i = endIdx + "\x1b[201~".length;
        continue;
      }

      const ch = chunk[i];

      // Escape sequences (bracketed paste, mouse wheel/selection, arrows, PgUp/PgDn, Home/End, Delete, Shift+Tab, Alt+keys)
      if (ch === "\x1b") {
        const rest = chunk.slice(i);

        // Start of bracketed paste: \x1b[200~
        if (rest.startsWith("\x1b[200~")) {
          this.inBracketedPaste = true;
          this.pasteBuffer = "";
          i += "\x1b[200~".length;
          continue;
        }

        // Mouse wheel, click, drag selection & release (SGR and X10)
        const mouse = parseMouseSequence(rest);
        if (mouse) {
          this.handleMouseEvent(mouse);
          i += mouse.length;
          continue;
        }

        // CSI sequences: \x1b[...
        const csi = rest.match(/^\x1b\[([0-9;]*[A-Za-z~])/);
        if (csi) {
          this.handleCsi(csi[1]);
          i += csi[0].length;
          continue;
        }

        // SS3 sequences: \x1bO...
        const ss3 = rest.match(/^\x1bO([A-Za-z])/);
        if (ss3) {
          if (ss3[1] === "H") this.cursor = 0;
          else if (ss3[1] === "F") this.cursor = this.input.length;
          this.scheduleRender();
          i += ss3[0].length;
          continue;
        }

        // Alt+b / Alt+f (word movement on macOS Terminal/iTerm2)
        if (rest.length >= 2) {
          const nextCh = rest[1];
          if (nextCh === "b") {
            this.moveWordLeft();
            i += 2;
            continue;
          }
          if (nextCh === "f") {
            this.moveWordRight();
            i += 2;
            continue;
          }
        }

        // Plain Esc: abort active stream, clear selection, or jump to bottom
        if (this.activeController) {
          this.activeController.abort();
          this.setNotice("Cancelling active agent run…");
        } else if (this.selection) {
          this.selection = null;
        } else if (this.scrollOffset > 0) {
          this.scrollOffset = 0;
        }
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+C
      if (ch === "\x03") {
        if (this.activeController) {
          this.activeController.abort();
          this.setNotice("Cancelling active agent run…");
        } else if (this.input.length > 0) {
          this.input = "";
          this.cursor = 0;
          this.setNotice("Cleared input. Press Ctrl+C again or /exit to quit.", 2000);
        } else {
          const now = Date.now();
          if (now - this.lastCtrlCAt < 1500) {
            this.shutdown();
            return;
          }
          this.lastCtrlCAt = now;
          this.setNotice("Press Ctrl+C again (or Ctrl+D / /exit) to quit.", 1600);
        }
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+D
      if (ch === "\x04") {
        if (this.input.length === 0) {
          this.shutdown();
          return;
        }
        // Delete forward
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
          this.scheduleRender();
        }
        i++;
        continue;
      }

      // Enter
      if (ch === "\r" || ch === "\n") {
        void this.handleSubmit();
        i++;
        continue;
      }

      // Tab
      if (ch === "\t") {
        const suggestion = this.getAutocompleteSuggestion();
        if (suggestion) {
          this.input = suggestion;
          this.cursor = this.input.length;
          this.scheduleRender();
        } else {
          this.cycleAgent(1);
        }
        i++;
        continue;
      }

      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor--;
          this.scheduleRender();
        }
        i++;
        continue;
      }

      // Ctrl+A (Home)
      if (ch === "\x01") {
        this.cursor = 0;
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+E (End)
      if (ch === "\x05") {
        this.cursor = this.input.length;
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+U (Clear line)
      if (ch === "\x15") {
        this.input = this.input.slice(this.cursor);
        this.cursor = 0;
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+K (Kill to end of line)
      if (ch === "\x0b") {
        this.input = this.input.slice(0, this.cursor);
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+V (Paste from system clipboard)
      if (ch === "\x16") {
        const clip = readFromClipboard();
        if (clip) {
          this.insertTextAtCursor(clip, true);
        } else {
          this.setNotice("Clipboard is empty or clipboard utility unavailable.", 2000);
        }
        i++;
        continue;
      }

      // Ctrl+Y (Copy current selection, or last assistant response if nothing selected)
      if (ch === "\x19") {
        if (!this.copySelectedText(true)) {
          const last = [...this.session.messages]
            .reverse()
            .find((m) => m.role === "assistant" && m.content.trim().length > 0);
          if (last) {
            copyToClipboard(last.content);
            writeOsc52Clipboard(last.content);
            this.setNotice(`Copied ${AGENT_META[last.agent ?? "claude"].label}'s last response to clipboard.`, 2500);
          } else {
            this.setNotice("Nothing selected or available to copy.", 2000);
          }
        }
        i++;
        continue;
      }

      // Ctrl+W (Delete word back)
      if (ch === "\x17") {
        const before = this.input.slice(0, this.cursor);
        const trimmed = before.replace(/\S+\s*$/, "");
        this.input = trimmed + this.input.slice(this.cursor);
        this.cursor = trimmed.length;
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+L (Redraw + scroll to bottom)
      if (ch === "\x0c") {
        this.scrollOffset = 0;
        process.stdout.write("\x1b[2J\x1b[H");
        this.scheduleRender();
        i++;
        continue;
      }

      // Ctrl+O (Open interactive model picker)
      if (ch === "\x0f") {
        this.openModelPicker(this.activeAgent);
        i++;
        continue;
      }

      // Ctrl+P / Ctrl+N (history)
      if (ch === "\x10") {
        this.navigateHistory(-1);
        i++;
        continue;
      }
      if (ch === "\x0e") {
        this.navigateHistory(1);
        i++;
        continue;
      }

      // Printable character
      if (ch >= " ") {
        this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
        this.cursor += ch.length;
        this.historyIndex = -1;
        this.scheduleRender();
      }
      i++;
    }
  }

  private handleCsi(seq: string): void {
    const pageStep = Math.max(4, Math.floor(this.lastViewportHeight * 0.75));
    const maxScroll = Math.max(0, this.lastTotalLines - this.lastViewportHeight);

    switch (seq) {
      case "D": // Left
        if (this.cursor > 0) this.cursor--;
        break;
      case "C": // Right
        if (this.cursor < this.input.length) this.cursor++;
        break;
      case "A": // Up -> prompt history
        this.navigateHistory(-1);
        return;
      case "B": // Down -> prompt history
        this.navigateHistory(1);
        return;
      case "H": // Home
      case "1~":
        this.cursor = 0;
        break;
      case "F": // End
      case "4~":
        if (this.input.length === 0 && this.scrollOffset > 0) {
          this.scrollOffset = 0;
        } else {
          this.cursor = this.input.length;
        }
        break;
      case "3~": // Delete
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        }
        break;
      case "Z": // Shift+Tab
        this.cycleAgent(-1);
        return;
      case "5~": // PageUp
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + pageStep);
        break;
      case "6~": // PageDown
        this.scrollOffset = Math.max(0, this.scrollOffset - pageStep);
        break;
      case "1;2A": // Shift+Up
      case "1;3A": // Alt+Up
      case "1;5A": // Ctrl+Up
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 3);
        break;
      case "1;2B": // Shift+Down
      case "1;3B": // Alt+Down
      case "1;5B": // Ctrl+Down
        this.scrollOffset = Math.max(0, this.scrollOffset - 3);
        break;
      case "1;3D": // Alt+Left
      case "1;5D": // Ctrl+Left
        this.moveWordLeft();
        return;
      case "1;3C": // Alt+Right
      case "1;5C": // Ctrl+Right
        this.moveWordRight();
        return;
    }

    this.scheduleRender();
  }

  private moveWordLeft(): void {
    const before = this.input.slice(0, this.cursor);
    const match = before.match(/^(.*?)(\S+\s*)$/);
    this.cursor = match ? match[1].length : 0;
    this.scheduleRender();
  }

  private moveWordRight(): void {
    const after = this.input.slice(this.cursor);
    const match = after.match(/^(\s*\S+)/);
    this.cursor = match ? this.cursor + match[1].length : this.input.length;
    this.scheduleRender();
  }

  private navigateHistory(direction: -1 | 1): void {
    if (this.promptHistory.length === 0) return;

    if (direction === -1) {
      if (this.historyIndex === -1) {
        this.historyDraft = this.input;
        this.historyIndex = this.promptHistory.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex--;
      }
      this.input = this.promptHistory[this.historyIndex];
      this.cursor = this.input.length;
    } else {
      if (this.historyIndex === -1) return;
      if (this.historyIndex < this.promptHistory.length - 1) {
        this.historyIndex++;
        this.input = this.promptHistory[this.historyIndex];
      } else {
        this.historyIndex = -1;
        this.input = this.historyDraft;
      }
      this.cursor = this.input.length;
    }

    this.scheduleRender();
  }

  private async handleSubmit(): Promise<void> {
    const raw = this.input;
    const trimmed = raw.trim();
    if (!trimmed) return;

    this.input = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.historyDraft = "";

    const parsed = parseInlineInput(trimmed);

    if (parsed.isSlashCommand) {
      this.handleSlashCommand(parsed.command || "", parsed.commandArgs || "");
      return;
    }

    if (parsed.listModels) {
      await this.showAllModelsInChat(parsed.agents);
      return;
    }

    if (parsed.listSkills) {
      this.showSkillsInChat();
      return;
    }

    if (parsed.switchOnly) {
      if (parsed.agents.length > 0) {
        const target = parsed.agents[0];
        this.activeAgent = target;
        this.session.activeAgent = target;
      }
      for (const [ag, mod] of Object.entries(parsed.agentModels)) {
        if (mod) this.modelOverrides[ag as AgentId] = mod;
      }
      if (parsed.modelOverride) {
        this.modelOverrides[this.activeAgent] = resolveModelAlias(
          this.activeAgent,
          parsed.modelOverride,
        );
      }
      saveSession(this.session);
      const activeMod = this.modelOverrides[this.activeAgent];
      const modSuffix = activeMod ? ` (model: ${activeMod})` : "";
      this.setNotice(
        `Active agent: --${this.activeAgent} (${AGENT_META[this.activeAgent].label})${modSuffix}`,
        2500,
      );
      return;
    }

    if (this.activeController) {
      this.setNotice("An agent is currently streaming. Press Ctrl+C or Esc to cancel first.", 2500);
      this.input = raw;
      this.cursor = raw.length;
      return;
    }

    this.promptHistory.push(trimmed);
    const targets: AgentTarget[] =
      parsed.targets.length > 0
        ? parsed.targets.map((t) => ({
            agent: t.agent,
            model:
              t.model ??
              (parsed.modelOverride ? resolveModelAlias(t.agent, parsed.modelOverride) : undefined) ??
              this.modelOverrides[t.agent],
          }))
        : [
            {
              agent: this.activeAgent,
              model:
                (parsed.modelOverride
                  ? resolveModelAlias(this.activeAgent, parsed.modelOverride)
                  : undefined) ?? this.modelOverrides[this.activeAgent],
            },
          ];

    // If user routed with a single --agent flag, also make it the active agent for follow-ups
    if (targets.length === 1 && parsed.targets.length === 1) {
      this.activeAgent = targets[0].agent;
      this.session.activeAgent = this.activeAgent;
    }

    const useDiscuss = parsed.discuss ?? this.agentDiscussion;
    const rounds = parsed.discussionRounds ?? this.discussionRounds;

    if (useDiscuss && targets.length < 2) {
      this.setNotice(
        "Agent discussion needs 2+ agents/models (e.g. --codex --gpt-5.6-sol --claude --opus). Running single agent.",
        4000,
      );
    }

    await this.dispatchTargets(targets, parsed.prompt, {
      discuss: useDiscuss && targets.length >= 2,
      rounds,
      synthesize: !parsed.noSynthesis,
      skills: parsed.skills,
    });
  }

  private handleSlashCommand(cmd: string, args: string): void {
    switch (cmd) {
      case "exit":
      case "quit":
      case "q":
        this.shutdown();
        return;

      case "help":
        this.addSystemMessage(
          [
            "**mcli Unified Multi-Agent Chat**",
            "",
            "**Switch or route inline with flags:**",
            "- `--claude <prompt>` / `--codex <prompt>` / `--agy <prompt>` / `--deepseek <prompt>` / `--kimi <prompt>`",
            "- `--claude:opus <prompt>` or `--claude --opus <prompt>` — choose firm + model per turn",
            "- `--codex --gpt-5.6-sol --claude --opus <prompt>` — run multiple firms & models on one job",
            "- Add `--agent discussion` (or `--discuss`, `--rounds 3`) to let the models peer-review each other and synthesize consensus",
            "- `--codex` or `--claude --opus` alone switches the active default agent / model",
            "- `@claude`, `@codex`, etc. also work as shortcuts",
            "",
            "**Shortcuts:**",
            "- `Ctrl+O`: open interactive model picker (`Up`/`Down` select, `Tab` switch agent, `S` save default)",
            "- `Tab` / `Shift+Tab`: autocomplete `--flags` or `/commands`, or cycle active agent",
            "- **Select & Copy:** Click-drag to highlight any words/sentences (auto-copies on release!), double-click a word, triple-click a line, or press `Ctrl+Y` (`Cmd+V` / `Ctrl+V` to paste)",
            "- `PgUp` / `PgDn`, mouse wheel, or `Alt+Up` / `Alt+Down`: scroll conversation (`/mouse off` for raw terminal selection)",
            "- `Up` / `Down`: prompt history",
            "- `Ctrl+C` / `Esc`: cancel active streaming response without quitting",
            "",
            "**Slash Commands:**",
            "- `/skills` or `--skills` — list all skills from Claude, Codex, Agy, Kimi & workspace",
            "- `/skill [use <name>|off <name>|clear|show <name>]` — pin/unpin or inspect skills across all agents (or use `--skill <name>` / `$<name>` per turn)",
            "- `/discuss [on|off|rounds <N>]` — toggle default multi-agent discussion mode",
            "- `/model` or `--models` — open model picker or list models across all 5 CLIs",
            "- `/model <name>` — set model for active agent (or `/model <agent> <name>`, `/model default`, `/model save`)",
            "- `/status` — detect all 5 CLIs & API fallback status",
            "- `/memory [status|set <agent[:model]|auto|local>|mode lean|balanced|full|auto on|off]` — assign a cheap/fast Scribe agent to manage memory and save tokens",
            "- `/compact [fast]` — compress older turns via your Memory Scribe agent (keeps recent turns verbatim)",
            "- `/context [on|off|show]` — toggle or inspect 3-tier shared memory & token usage sent to agents",
            "- `/clear` — reset shared conversation history and summary",
            "- `/mouse [on|off]` — toggle mouse wheel scrolling vs native text selection",
            "- `/session [list|save <name>|load <name>|new <name>]` — manage persistent sessions",
            "- `/copy` — copy last assistant response to clipboard",
            "- `/export [file.md]` — export conversation to Markdown",
            "- `/config` — show config file path",
            "- `/exit` — quit mcli",
          ].join("\n"),
        );
        return;

      case "skills":
        this.showSkillsInChat();
        return;

      case "skill": {
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = (parts[0] || "list").toLowerCase();
        this.availableSkills = discoverSkills(this.cwd, this.config);

        if (sub === "list") {
          this.showSkillsInChat();
          return;
        }
        if (sub === "clear") {
          this.session.pinnedSkills = [];
          saveSession(this.session);
          this.setNotice("Cleared all pinned session skills.");
          return;
        }
        if ((sub === "use" || sub === "add" || sub === "pin") && parts[1]) {
          const { resolved, missing } = resolveRequestedSkills(parts.slice(1), this.availableSkills);
          const current = new Set(this.session.pinnedSkills ?? []);
          for (const s of resolved) current.add(s.name);
          this.session.pinnedSkills = Array.from(current);
          saveSession(this.session);
          if (resolved.length > 0 && missing.length === 0) {
            this.setNotice(`Pinned skill(s) for this session: ${resolved.map((s) => s.name).join(", ")}`);
          } else if (resolved.length > 0) {
            this.setNotice(`Pinned: ${resolved.map((s) => s.name).join(", ")} (not found: ${missing.join(", ")})`);
          } else {
            this.setNotice(`Skill(s) not found: ${missing.join(", ")}. Type /skills to list.`);
          }
          return;
        }
        if ((sub === "off" || sub === "remove" || sub === "unpin") && parts[1]) {
          const drop = new Set(parts.slice(1).map((p) => p.toLowerCase()));
          this.session.pinnedSkills = (this.session.pinnedSkills ?? []).filter(
            (n) => !drop.has(n.toLowerCase()),
          );
          saveSession(this.session);
          this.setNotice(
            `Pinned skills: ${(this.session.pinnedSkills ?? []).join(", ") || "none"}`,
          );
          return;
        }
        if (sub === "show" && parts[1]) {
          const { resolved } = resolveRequestedSkills([parts[1]], this.availableSkills);
          if (resolved[0]) {
            const s = resolved[0];
            this.addSystemMessage(
              [
                `**Skill: \`${s.name}\`** *([${s.source}] — \`${s.filePath}\`)*`,
                s.description ? `\n> ${s.description}` : "",
                "",
                s.body.slice(0, 4000) + (s.body.length > 4000 ? "\n\n*…[truncated]*" : ""),
              ]
                .filter(Boolean)
                .join("\n"),
            );
          } else {
            this.setNotice(`Skill "${parts[1]}" not found. Type /skills to list.`);
          }
          return;
        }
        this.setNotice("Usage: /skill [list | use <name> | off <name> | clear | show <name>]");
        return;
      }

      case "status":
      case "agents": {
        this.availability = detectAllAgents(this.config);
        const lines = ["**Agent Availability:**", ""];
        for (const id of AGENT_IDS) {
          const info = this.availability[id];
          const tag = info.mode === "cli" ? "CLI" : info.mode === "api" ? "API" : "MISSING";
          const model = this.modelOverrides[id] || this.config.agents[id]?.model;
          const modelStr = model ? ` (model: \`${model}\`)` : "";
          lines.push(`- \`--${id}\` **[${tag}]** — ${info.detail}${modelStr}`);
        }
        this.addSystemMessage(lines.join("\n"));
        return;
      }

      case "clear":
        this.session.messages = [];
        this.session.agentSessions = {};
        this.session.summary = undefined;
        this.session.summarizedUpTo = undefined;
        saveSession(this.session);
        this.scrollOffset = 0;
        this.setNotice("Cleared shared conversation history and rolling summary.");
        return;

      case "compact": {
        if (this.activeController || this.memoryCompacting) {
          this.setNotice("Wait for active generation/compaction to finish first.");
          return;
        }
        const fast = args.trim().toLowerCase() === "fast";
        const scribe = fast
          ? { label: "local digest ($0)" }
          : resolveMemoryScribe(this.config, this.availability);
        this.memoryCompacting = true;
        this.setNotice(`Compacting older turns with Memory Scribe: ${scribe.label}…`, 6000);
        void runMemoryScribe({
          session: this.session,
          cwd: this.cwd,
          config: this.config,
          availability: this.availability,
          forceLocal: fast,
        })
          .then((res) => {
            if (res.compactedTurns === 0) {
              this.setNotice("Not enough older turns to compact yet (recent turns stay verbatim).");
            } else {
              this.addSystemMessage(
                [
                  `**Memory Scribe (${res.scribeLabel}) compacted ${res.compactedTurns} turn(s) — saved ~${res.estimatedTokensSaved.toLocaleString()} tokens/turn:**`,
                  "",
                  res.summary,
                ].join("\n"),
              );
              this.setNotice(`Memory compacted by ${res.scribeLabel} (saved ~${res.estimatedTokensSaved} tokens).`);
            }
          })
          .finally(() => {
            this.memoryCompacting = false;
          });
        return;
      }

      case "memory": {
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = (parts[0] || "status").toLowerCase();

        if (sub === "status" || sub === "show") {
          const scribe = resolveMemoryScribe(this.config, this.availability);
          const eff = getEffectiveContextConfig(this.config, this.shareContext);
          const { stats } = buildSharedContextBlock({
            history: this.session.messages,
            targetAgent: this.activeAgent,
            config: eff,
            sessionSummary: this.session.summary,
            summarizedUpTo: this.session.summarizedUpTo,
            transcriptPath: getSessionTranscriptPath(this.session.id),
          });
          this.addSystemMessage(
            [
              "**Memory Scribe Agent (Token Saver)**",
              "",
              `- **Assigned Scribe:** ${scribe.label} (config: \`${this.config.memory.agent}${this.config.memory.model ? `:${this.config.memory.model}` : ""}\`)`,
              `- **Memory Mode:** \`${this.config.memory.mode}\` (window cap: ${eff.maxContextChars.toLocaleString()} chars / ${eff.maxContextTurns} turns)`,
              `- **Auto-Compact:** ${this.config.memory.autoCompact ? `ON (threshold: ${this.config.memory.autoCompactThresholdChars.toLocaleString()} chars)` : "OFF"}`,
              `- **Current Context Sent to Next Agent:** ~${stats.estimatedTokens.toLocaleString()} tokens (${stats.contextChars.toLocaleString()} chars)`,
              "",
              "**Commands:**",
              "- `/memory set claude:haiku` or `/memory set deepseek:chat` or `/memory set agy:gemini-2.5-flash` or `/memory set codex:o4-mini`",
              "- `/memory set local` (zero tokens / $0 instant local digest) or `/memory set auto`",
              "- `/memory mode lean` (summary + last 1 turn — minimum tokens) | `balanced` | `full`",
              "- `/memory auto on|off`",
            ].join("\n"),
          );
          return;
        }

        if (sub === "set" && parts[1]) {
          const rawArg = parts.slice(1).join(" ").trim();
          const cleanedFirst = parts[1].replace(/^(--|@)/, "").toLowerCase();
          if (cleanedFirst === "auto" || cleanedFirst === "local") {
            this.config.memory.agent = cleanedFirst;
            this.config.memory.model = undefined;
            saveConfig(this.config);
            const scribe = resolveMemoryScribe(this.config, this.availability);
            this.setNotice(`Memory Scribe set to ${scribe.label} (saved to ~/.mcli/config.json).`);
            return;
          }
          const inlineParsed = parseInlineInput(
            rawArg.startsWith("--") || rawArg.startsWith("@") ? rawArg : `--${rawArg}`,
          );
          const picked = inlineParsed.targets[0];
          if (picked) {
            this.config.memory.agent = picked.agent;
            this.config.memory.model =
              picked.model ?? (parts[2] ? resolveModelAlias(picked.agent, parts[2].replace(/^--/, "")) : undefined);
            saveConfig(this.config);
            const scribe = resolveMemoryScribe(this.config, this.availability);
            this.setNotice(`Memory Scribe set to ${scribe.label} (saved to ~/.mcli/config.json).`);
            return;
          }
          this.setNotice("Usage: /memory set <claude:haiku | deepseek:chat | agy:gemini-2.5-flash | codex:o4-mini | auto | local>");
          return;
        }

        if (sub === "mode" && (parts[1] === "lean" || parts[1] === "balanced" || parts[1] === "full")) {
          this.config.memory.mode = parts[1];
          saveConfig(this.config);
          this.setNotice(`Memory mode set to "${parts[1]}" (saved to ~/.mcli/config.json).`);
          return;
        }

        if (sub === "auto") {
          const next = parts[1] === "on" ? true : parts[1] === "off" ? false : !this.config.memory.autoCompact;
          this.config.memory.autoCompact = next;
          saveConfig(this.config);
          this.setNotice(`Auto-compaction via Memory Scribe: ${next ? "ON" : "OFF"} (saved).`);
          return;
        }

        this.setNotice("Usage: /memory [status | set <agent[:model]|auto|local> | mode lean|balanced|full | auto on|off]");
        return;
      }

      case "history": {
        if (this.session.messages.length === 0) {
          this.setNotice("No messages in this session yet.");
          return;
        }
        const lines = [`**Session "${this.session.name}" (${this.session.messages.length} entries):**`, ""];
        for (const msg of this.session.messages.slice(-20)) {
          if (msg.role === "system") continue;
          const who = msg.role === "user" ? "You" : AGENT_META[msg.agent ?? "claude"].label;
          const preview = msg.content.replace(/\s+/g, " ").slice(0, 72);
          lines.push(`- **${who}**: ${preview}${msg.content.length > 72 ? "…" : ""}`);
        }
        this.addSystemMessage(lines.join("\n"));
        return;
      }

      case "context":
        if (args === "on") {
          this.shareContext = true;
          this.setNotice(`Shared cross-agent context is now ON (max ${this.config.maxContextTurns} turns).`);
        } else if (args === "off") {
          this.shareContext = false;
          this.setNotice("Shared cross-agent context is now OFF.");
        } else if (args === "show" || args === "status") {
          const transcriptPath = getSessionTranscriptPath(this.session.id);
          const eff = getEffectiveContextConfig(this.config, this.shareContext);
          const scribe = resolveMemoryScribe(this.config, this.availability);
          const { contextBlock, stats } = buildSharedContextBlock({
            history: this.session.messages,
            targetAgent: this.activeAgent,
            config: eff,
            sessionSummary: this.session.summary,
            summarizedUpTo: this.session.summarizedUpTo,
            transcriptPath,
          });
          const lines = [
            `**Shared Conversation Memory (3-Tier)**`,
            "",
            `- **Status:** ${this.shareContext ? "ON" : "OFF"} · mode: \`${this.config.memory.mode}\` · scribe: **${scribe.label}**`,
            `- **Tier 1 (Rolling Summary):** ${this.session.summary ? `active (${this.session.summarizedUpTo ?? 0} msgs compacted)` : "none yet — auto-compacts or run \`/compact\`"}`,
            `- **Tier 2 (Active Window):** ${stats.includedTurns} turn(s) · ~${stats.estimatedTokens} tokens (${stats.contextChars} chars) · ${stats.foldedDiscussions} older discussion(s) folded · ${stats.overflowDigestedTurns} overflow turn(s) auto-digested`,
            `- **Tier 3 (Full Transcript File):** \`${transcriptPath}\``,
          ];
          if (this.session.summary?.trim()) {
            lines.push("", "**Current Rolling Summary:**", "", this.session.summary.trim());
          } else if (!contextBlock) {
            lines.push("", "*No shared history yet.*");
          }
          this.addSystemMessage(lines.join("\n"));
        } else {
          this.shareContext = !this.shareContext;
          this.setNotice(
            `Shared cross-agent context is now ${this.shareContext ? "ON" : "OFF"} (use /context show to inspect).`,
          );
        }
        return;

      case "discuss":
      case "discussion": {
        const parts = args.split(/\s+/).filter(Boolean);
        if (parts[0] === "on") {
          this.agentDiscussion = true;
        } else if (parts[0] === "off") {
          this.agentDiscussion = false;
        } else if (parts[0] === "rounds" && parts[1]) {
          const n = Number.parseInt(parts[1], 10);
          if (Number.isFinite(n) && n >= 1) {
            this.discussionRounds = Math.min(6, n);
            this.agentDiscussion = true;
          }
        } else {
          this.agentDiscussion = !this.agentDiscussion;
        }
        this.setNotice(
          this.agentDiscussion
            ? `Agent discussion ON by default (${this.discussionRounds} rounds + synthesis for 2+ models).`
            : "Agent discussion OFF by default (add --discuss or --agent discussion on any multi-model prompt).",
        );
        return;
      }

      case "mouse":
        if (args === "on") this.setMouseTracking(true);
        else if (args === "off") this.setMouseTracking(false);
        else this.setMouseTracking(!this.mouseEnabled);
        this.setNotice(
          `Mouse wheel scrolling ${this.mouseEnabled ? "ON (hold Shift/Option to select text)" : "OFF (native text selection enabled)"}.`,
        );
        return;

      case "models": {
        const filter = args
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => t.replace(/^--/, "").toLowerCase())
          .filter(isAgentId);
        void this.showAllModelsInChat(filter);
        return;
      }

      case "model": {
        const parts = args.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          this.openModelPicker(this.activeAgent);
          return;
        }
        if (parts[0] === "save") {
          for (const id of AGENT_IDS) {
            if (this.modelOverrides[id] !== undefined) {
              this.config.agents[id] = { ...this.config.agents[id], model: this.modelOverrides[id] };
            }
          }
          const savedPath = saveConfig(this.config);
          this.setNotice(`Saved model defaults to ${savedPath}`);
          return;
        }
        if (parts.length === 1 && isAgentId(parts[0].toLowerCase())) {
          this.openModelPicker(parts[0].toLowerCase() as AgentId);
          return;
        }
        if (parts.length >= 2 && isAgentId(parts[0].toLowerCase())) {
          const target = parts[0].toLowerCase() as AgentId;
          const rawVal = parts.slice(1).join(" ");
          if (rawVal === "default") {
            delete this.modelOverrides[target];
            this.setNotice(`Reset model override for --${target}.`);
          } else {
            const resolved = resolveModelAlias(target, rawVal);
            this.modelOverrides[target] = resolved;
            this.setNotice(`Set --${target} model to ${resolved} (use /model save to persist).`);
          }
          return;
        }
        if (parts[0] === "default") {
          delete this.modelOverrides[this.activeAgent];
          this.setNotice(`Reset model override for --${this.activeAgent}.`);
        } else {
          const resolved = resolveModelAlias(this.activeAgent, parts.join(" "));
          this.modelOverrides[this.activeAgent] = resolved;
          this.setNotice(
            `Set --${this.activeAgent} model to ${resolved} (use /model save to persist).`,
          );
        }
        return;
      }

      case "session": {
        const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
        const targetName = rest.join("-");
        if (!sub || sub === "list") {
          const all = listSessions();
          if (all.length === 0) {
            this.addSystemMessage("No saved sessions yet.");
          } else {
            const lines = ["**Saved Sessions:**", ""];
            for (const s of all.slice(0, 12)) {
              const mark = s.id === this.session.id ? " *(current)*" : "";
              const sum = s.hasSummary ? " · has summary" : "";
              lines.push(`- \`${s.id}\`${mark} — ${s.messageCount} msgs${sum} (${s.cwd})`);
            }
            this.addSystemMessage(lines.join("\n"));
          }
          return;
        }
        if (sub === "save" && targetName) {
          this.session = saveSessionAs(this.session, targetName);
          this.setNotice(
            `Saved session snapshot as "${this.session.id}" (+ .md transcript).`,
          );
          return;
        }
        if ((sub === "load" || sub === "new") && targetName) {
          saveSession(this.session);
          this.session = loadOrCreateSession({
            name: targetName,
            cwd: this.cwd,
            activeAgent: this.activeAgent,
            fresh: sub === "new",
          });
          this.scrollOffset = 0;
          this.setNotice(`Session "${this.session.name}" active (${this.session.messages.length} msgs).`);
          return;
        }
        this.setNotice("Usage: /session [list | save <name> | load <name> | new <name>]");
        return;
      }

      case "copy": {
        const last = [...this.session.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.content.trim().length > 0);
        if (!last) {
          this.setNotice("No assistant message to copy yet.");
          return;
        }
        if (copyToClipboard(last.content)) {
          this.setNotice(`Copied ${AGENT_META[last.agent ?? "claude"].label}'s last response to clipboard.`);
        } else {
          this.setNotice("Clipboard command (pbcopy/wl-copy/xclip) unavailable.");
        }
        return;
      }

      case "export": {
        const filename = args || `${this.session.id}.md`;
        const outPath = path.resolve(this.cwd, filename);
        try {
          fs.writeFileSync(outPath, exportSessionMarkdown(this.session), "utf8");
          this.setNotice(`Exported conversation to ${outPath}`);
        } catch (err) {
          this.setNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      case "config":
        this.addSystemMessage(
          `Config file: \`${getConfigPath()}\`\n\nRun \`mcli --init-config\` to write a template config with per-agent overrides (\`command\`, \`extraArgs\`, \`outputMode\`, \`model\`, \`apiKey\`).`,
        );
        return;

      default:
        this.setNotice(`Unknown command "/${cmd}". Type /help for available commands.`);
    }
  }

  private showSkillsInChat(): void {
    this.availableSkills = discoverSkills(this.cwd, this.config);
    const pinnedSet = new Set((this.session.pinnedSkills ?? []).map((s) => s.toLowerCase()));
    if (this.availableSkills.length === 0) {
      this.addSystemMessage(
        [
          "**No `SKILL.md` skills found.**",
          "",
          "Checked: `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.kimi/skills`, `~/.mcli/skills`, and workspace `.claude/.codex/.agents/skills`.",
          "You can also add custom paths via `skillDirs` in `~/.mcli/config.json`.",
        ].join("\n"),
      );
      return;
    }

    const lines: string[] = [
      `**Unified Skills (${this.availableSkills.length} found across Claude, Codex, Agy, Kimi & Workspace):**`,
      "",
    ];
    for (const s of this.availableSkills) {
      const pinned = pinnedSet.has(s.name.toLowerCase()) ? " **[pinned]**" : "";
      const desc = s.description
        ? ` — ${s.description.slice(0, 96)}${s.description.length > 96 ? "…" : ""}`
        : "";
      lines.push(`- \`${s.name}\` **[${s.source}]**${pinned}${desc}`);
    }
    lines.push(
      "",
      "Use any skill on any agent with `--skill <name>` or `$<name>`, or pin for the session with `/skill use <name>`.",
    );
    this.addSystemMessage(lines.join("\n"));
  }

  private async dispatchTargets(
    targets: AgentTarget[],
    userPrompt: string,
    discussionOpts: { discuss: boolean; rounds: number; synthesize: boolean; skills?: string[] },
  ): Promise<void> {
    const historySnapshot = [...this.session.messages];
    const transcriptPath = getSessionTranscriptPath(this.session.id);

    // Resolve pinned + per-turn skills across all CLI skill directories
    const requestedSkillNames = Array.from(
      new Set([...(this.session.pinnedSkills ?? []), ...(discussionOpts.skills ?? [])]),
    );
    if (requestedSkillNames.length > 0) {
      this.availableSkills = discoverSkills(this.cwd, this.config);
    }
    const { resolved: activeSkills, missing: missingSkills } = resolveRequestedSkills(
      requestedSkillNames,
      this.availableSkills,
    );
    const skillsPromptBlock = buildSkillsPromptBlock(activeSkills);
    if (missingSkills.length > 0) {
      this.setNotice(`Skill(s) not found: ${missingSkills.join(", ")} (run /skills to list).`, 4000);
    }

    const targetListLabel =
      targets.length > 1
        ? targets.map((t) => formatTargetLabel(t)).join(discussionOpts.discuss ? " ↔ " : " + ")
        : undefined;
    const skillTag =
      activeSkills.length > 0 ? ` · skills: ${activeSkills.map((s) => s.name).join(", ")}` : "";

    const userMsg: ChatMessage = {
      id: createMessageId(),
      role: "user",
      agent: targets[0]?.agent,
      roundLabel: targetListLabel
        ? `${targetListLabel}${discussionOpts.discuss ? ` · Discussion (${discussionOpts.rounds}r)` : ""}${skillTag}`
        : skillTag
          ? `${formatTargetLabel(targets[0])}${skillTag}`
          : undefined,
      content: userPrompt,
      timestamp: new Date().toISOString(),
    };
    this.session.messages.push(userMsg);
    this.scrollOffset = 0;

    const controller = new AbortController();
    this.activeController = controller;

    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
      this.scheduleRender();
    }, 90);

    const effectiveLimits = getEffectiveContextConfig(this.config, this.shareContext);
    const effectiveConfig: McliConfig = {
      ...this.config,
      ...effectiveLimits,
      agentDiscussion: this.agentDiscussion,
      discussionRounds: discussionOpts.rounds,
    };

    try {
      if (discussionOpts.discuss && targets.length >= 2) {
        let roundCommittedCount = 0;
        let currentRoundMessages: ChatMessage[] = [];

        const commitFinishedRound = (): void => {
          if (currentRoundMessages.length > 0) {
            this.session.messages.push(...currentRoundMessages);
            roundCommittedCount += currentRoundMessages.length;
            currentRoundMessages = [];
          }
        };

        const discResult = await runAgentDiscussion({
          targets,
          userPrompt,
          history: historySnapshot,
          sessionSummary: this.session.summary,
          summarizedUpTo: this.session.summarizedUpTo,
          transcriptPath,
          skills: activeSkills,
          cwd: this.cwd,
          config: effectiveConfig,
          rounds: discussionOpts.rounds,
          synthesize: discussionOpts.synthesize,
          signal: controller.signal,
          parallel: true,
          onRoundStart: ({ roundLabel, participants }) => {
            commitFinishedRound();
            this.liveStreams = participants.map((t) => ({
              agent: t.agent,
              model: t.model ?? this.config.agents[t.agent]?.model,
              roundLabel,
              text: "",
              reasoning: "",
              tools: [],
              startedAt: Date.now(),
              done: false,
            }));
            this.scheduleRender();
          },
          onParticipantEvent: ({ index, event }) => {
            const stream = this.liveStreams[index];
            if (!stream) return;
            if (event.type === "text" && event.text) {
              stream.text += event.text;
            } else if (event.type === "reasoning" && event.text) {
              stream.reasoning += event.text;
            } else if (event.type === "tool" && event.toolName) {
              stream.tools.push({ name: event.toolName, detail: event.toolDetail });
            } else if (event.type === "error" && event.text) {
              stream.error = event.text;
            }
            this.scheduleRender();
          },
          onParticipantDone: ({ index, target, roundLabel, result }) => {
            const stream = this.liveStreams[index];
            if (stream) stream.done = true;
            const agentConfig = this.config.agents[target.agent] ?? {};
            currentRoundMessages.push({
              id: createMessageId(),
              role: "assistant",
              agent: target.agent,
              model: target.model ?? agentConfig.model,
              roundLabel,
              content: result.text,
              reasoning: result.reasoning || undefined,
              tools: result.tools.length > 0 ? result.tools : undefined,
              timestamp: new Date().toISOString(),
              durationMs: result.durationMs,
              error: result.error,
              aborted: result.aborted,
            });
            this.scheduleRender();
          },
        });

        commitFinishedRound();
        Object.assign(this.session.agentSessions, discResult.sessionIds);
        if (roundCommittedCount === 0 && discResult.messages.length > 0) {
          this.session.messages.push(...discResult.messages);
        }
        saveSession(this.session);
      } else {
        this.liveStreams = targets.map((t) => ({
          agent: t.agent,
          model: t.model ?? this.config.agents[t.agent]?.model,
          text: "",
          reasoning: "",
          tools: [],
          startedAt: Date.now(),
          done: false,
        }));
        this.scheduleRender();

        const results = await Promise.all(
          targets.map(async (target, idx) => {
            const stream = this.liveStreams[idx];
            const adapter = getAdapter(target.agent);
            const agentConfig = this.config.agents[target.agent] ?? {};

            const fullPrompt = prependSkillsToPrompt(
              buildPromptWithContext({
                userPrompt,
                history: historySnapshot,
                targetAgent: target.agent,
                config: effectiveConfig,
                sessionSummary: this.session.summary,
                summarizedUpTo: this.session.summarizedUpTo,
                transcriptPath,
              }),
              activeSkills,
            );

            const res = await adapter.run({
              prompt: fullPrompt,
              rawUserPrompt: userPrompt,
              history: historySnapshot,
              sessionSummary: this.session.summary,
              summarizedUpTo: this.session.summarizedUpTo,
              transcriptPath,
              skillsPromptBlock,
              cwd: this.cwd,
              model: target.model,
              sessionId: this.session.agentSessions[target.agent],
              config: agentConfig,
              signal: controller.signal,
              onEvent: (ev) => {
                if (ev.type === "text" && ev.text) {
                  stream.text += ev.text;
                } else if (ev.type === "reasoning" && ev.text) {
                  stream.reasoning += ev.text;
                } else if (ev.type === "tool" && ev.toolName) {
                  stream.tools.push({ name: ev.toolName, detail: ev.toolDetail });
                } else if (ev.type === "error" && ev.text) {
                  stream.error = ev.text;
                }
                this.scheduleRender();
              },
            });

            stream.done = true;
            if (res.sessionId) {
              this.session.agentSessions[target.agent] = res.sessionId;
            }
            this.scheduleRender();

            return { target, res };
          }),
        );

        for (const { target, res } of results) {
          const agentConfig = this.config.agents[target.agent] ?? {};
          this.session.messages.push({
            id: createMessageId(),
            role: "assistant",
            agent: target.agent,
            model: target.model ?? agentConfig.model,
            content: res.text,
            reasoning: res.reasoning || undefined,
            tools: res.tools.length > 0 ? res.tools : undefined,
            timestamp: new Date().toISOString(),
            durationMs: res.durationMs,
            error: res.error,
            aborted: res.aborted,
          });
        }

        saveSession(this.session);
      }
    } finally {
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      this.activeController = null;
      this.liveStreams = [];
      this.scheduleRender();
      this.maybeTriggerBackgroundMemoryScribe();
    }
  }

  private maybeTriggerBackgroundMemoryScribe(): void {
    if (this.memoryCompacting || !shouldAutoCompact(this.session, this.config)) {
      return;
    }
    const targetSession = this.session;
    const expectedId = targetSession.id;
    const scribe = resolveMemoryScribe(this.config, this.availability);
    this.memoryCompacting = true;
    this.setNotice(`✎ Memory Scribe (${scribe.label}) compacting older turns in background…`, 4000);

    void runMemoryScribe({
      session: targetSession,
      cwd: this.cwd,
      config: this.config,
      availability: this.availability,
    })
      .then((res) => {
        if (this.session.id === expectedId && res.compactedTurns > 0) {
          this.setNotice(
            `✎ Memory updated by ${res.scribeLabel} · compacted ${res.compactedTurns} turn(s), saved ~${res.estimatedTokensSaved.toLocaleString()} tokens/turn`,
            4500,
          );
        }
      })
      .finally(() => {
        this.memoryCompacting = false;
      });
  }

  private buildHeaderLines(cols: number): string[] {
    const brand = `${BG.darkGray}${FG.brightWhite}${BOLD} mcli ${RESET}`;
    const pills = AGENT_IDS.map((id) => {
      const avail = this.availability[id];
      const dot = avail.mode === "cli" ? "●" : avail.mode === "api" ? "◌" : "✕";
      const isActive = id === this.activeAgent;
      if (isActive) {
        return `${agentBg(id)}${FG.black}${BOLD} ${dot} --${id} ${RESET}`;
      }
      const dotColor =
        avail.mode === "cli" ? FG.green : avail.mode === "api" ? FG.cyan : FG.gray;
      return `${dotColor}${dot}${RESET} ${style(`--${id}`, avail.available ? agentFg(id) : FG.gray)}`;
    });

    const row1 = truncateVisible(`${brand}  ${pills.join("  ")}`, cols);

    const dirName = path.basename(this.cwd) || this.cwd;
    const msgCount = this.session.messages.filter((m) => m.role !== "system").length;
    const activeModel = this.modelOverrides[this.activeAgent] ?? this.config.agents[this.activeAgent]?.model;
    const modelPart = activeModel ? `  •  model: ${activeModel}` : "  •  model: default";
    const discPart = this.agentDiscussion ? `  •  discuss: on (${this.discussionRounds}r)` : "";
    const pinnedSkills = this.session.pinnedSkills ?? [];
    const skillPart = pinnedSkills.length > 0 ? `  •  skills: ${pinnedSkills.join(",")}` : "";
    const ctxPart = `context: ${this.shareContext ? "on" : "off"} (${msgCount} msgs)`;
    const row2 = truncateVisible(
      style(
        ` dir: ${dirName}  •  session: ${this.session.name}  •  ${ctxPart}${modelPart}${discPart}${skillPart}  •  Ctrl+O: models  •  /help`,
        DIM,
      ),
      cols,
    );

    const divider = style("─".repeat(cols), DIM, FG.gray);
    return [row1, row2, divider];
  }

  private buildWelcomeLines(cols: number): string[] {
    const lines: string[] = [""];
    lines.push("  " + style("Welcome to mcli — Unified Multi-Agent CLI Window", BOLD, FG.brightWhite));
    lines.push(
      "  " +
        style(
          "Chat with Claude, Codex, Agy, DeepSeek, and Kimi in one window with shared history.",
          DIM,
        ),
    );
    lines.push("");
    lines.push("  " + style("Quick Examples:", BOLD, FG.cyan));
    lines.push("    " + style("--claude", agentFg("claude"), BOLD) + " explain this codebase");
    lines.push("    " + style("--codex", agentFg("codex"), BOLD) + " write tests for what Claude just explained");
    lines.push("    " + style("--agy", agentFg("agy"), BOLD) + " refactor the config loader");
    lines.push("    " + style("--deepseek", agentFg("deepseek"), BOLD) + " review the tradeoffs");
    lines.push("    " + style("--kimi", agentFg("kimi"), BOLD) + " summarize all changes");
    lines.push(
      "    " +
        style("--claude --codex", BOLD, FG.brightWhite) +
        " compare two approaches in parallel",
    );
    lines.push("");
    lines.push("  " + style("Detected Agents:", BOLD, FG.cyan));
    for (const id of AGENT_IDS) {
      const info = this.availability[id];
      const badge =
        info.mode === "cli"
          ? style("● CLI ", FG.brightGreen, BOLD)
          : info.mode === "api"
            ? style("◌ API ", FG.brightCyan, BOLD)
            : style("✕ OFF ", FG.brightRed, BOLD);
      lines.push(
        truncateVisible(
          `    ${badge} ${agentFg(id)}${BOLD}${AGENT_META[id].flag.padEnd(11)}${RESET} ${style(info.detail, DIM)}`,
          cols,
        ),
      );
    }
    lines.push("");
    return lines;
  }

  private buildConversationLines(cols: number): string[] {
    if (this.session.messages.length === 0 && this.liveStreams.length === 0) {
      return this.buildWelcomeLines(cols);
    }

    const lines: string[] = [""];

    for (const msg of this.session.messages) {
      if (msg.role === "system") {
        lines.push("  " + style("◆ System", BOLD, FG.cyan));
        lines.push(...renderMarkdownLines(msg.content, cols, "    "));
        lines.push("");
        continue;
      }

      if (msg.role === "user") {
        const targetSuffix = msg.roundLabel
          ? ` ${style("→", DIM)} ${style(msg.roundLabel, FG.brightCyan, BOLD)}`
          : msg.agent
            ? ` ${style("→", DIM)} ${style(`--${msg.agent}`, agentFg(msg.agent), BOLD)}`
            : "";
        lines.push(`  ${style("❯ You", BOLD, FG.brightWhite)}${targetSuffix}`);
        for (const wl of wrapPlainText(msg.content, Math.max(12, cols - 4))) {
          lines.push("    " + style(wl, FG.white));
        }
        lines.push("");
        continue;
      }

      if (msg.role === "assistant") {
        const agent = msg.agent ?? "claude";
        const modelStr = msg.model ? style(` (${msg.model})`, DIM) : "";
        const roundStr = msg.roundLabel ? style(` [${msg.roundLabel}]`, FG.brightCyan) : "";
        const durStr = msg.durationMs !== undefined ? style(` · ${formatDuration(msg.durationMs)}`, DIM) : "";
        const abortStr = msg.aborted ? style(" · cancelled", FG.yellow) : "";
        lines.push(`  ${agentBadge(agent, false)}${modelStr}${roundStr}${durStr}${abortStr}`);

        if (msg.tools && msg.tools.length > 0) {
          for (const t of msg.tools.slice(-8)) {
            const detail = t.detail ? `: ${t.detail}` : "";
            lines.push(truncateVisible("    " + style(`⚙ ${t.name}${detail}`, DIM, FG.cyan), cols));
          }
        }

        if (msg.reasoning && msg.reasoning.trim()) {
          const preview = msg.reasoning.replace(/\s+/g, " ").trim().slice(0, Math.max(20, cols - 18));
          lines.push(truncateVisible("    " + style(`💭 ${preview}`, DIM, ITALIC), cols));
        }

        if (msg.content.trim()) {
          lines.push(...renderMarkdownLines(msg.content, cols, "    "));
        }

        if (msg.error) {
          for (const wl of wrapPlainText(msg.error, Math.max(12, cols - 8))) {
            lines.push("    " + style(`✕ ${wl}`, FG.brightRed));
          }
        }

        lines.push("");
      }
    }

    // Active live streaming panels
    for (const stream of this.liveStreams) {
      const spin = stream.done
        ? style("✓", FG.brightGreen)
        : style(SPINNER_FRAMES[this.spinnerIdx], agentFg(stream.agent), BOLD);
      const elapsed = formatDuration(Date.now() - stream.startedAt);
      const modelStr = stream.model ? style(` (${stream.model})`, DIM) : "";
      const roundStr = stream.roundLabel ? style(` [${stream.roundLabel}]`, FG.brightCyan) : "";
      lines.push(
        `  ${spin} ${agentBadge(stream.agent, true)}${modelStr}${roundStr} ${style(stream.done ? `done (${elapsed})` : `streaming… ${elapsed}`, DIM)}`,
      );

      if (stream.tools.length > 0) {
        for (const t of stream.tools.slice(-6)) {
          const detail = t.detail ? `: ${t.detail}` : "";
          lines.push(truncateVisible("    " + style(`⚙ ${t.name}${detail}`, DIM, FG.cyan), cols));
        }
      }

      if (stream.reasoning.trim()) {
        const tail = stream.reasoning.replace(/\s+/g, " ").trim().slice(-Math.max(20, cols - 18));
        lines.push(truncateVisible("    " + style(`💭 ${tail}`, DIM, ITALIC), cols));
      }

      if (stream.text.trim()) {
        lines.push(...renderMarkdownLines(stream.text, cols, "    "));
      } else if (!stream.done && !stream.error) {
        lines.push("    " + style("Waiting for response…", DIM));
      }

      if (stream.error) {
        for (const wl of wrapPlainText(stream.error, Math.max(12, cols - 8))) {
          lines.push("    " + style(`✕ ${wl}`, FG.brightRed));
        }
      }

      lines.push("");
    }

    return lines;
  }

  private buildModelPickerLines(cols: number): string[] {
    if (!this.modelPicker) return [];
    const { agent, items, selectedIndex } = this.modelPicker;
    const activeModel = this.modelOverrides[agent] ?? this.config.agents[agent]?.model;

    const tabs = AGENT_IDS.map((id) =>
      id === agent
        ? `${agentBg(id)}${FG.black}${BOLD} --${id} ${RESET}`
        : style(`--${id}`, DIM, agentFg(id)),
    ).join("  ");

    const lines: string[] = [
      "",
      `  ${style("Model Picker", BOLD, FG.brightWhite)}  ${style("(Tab / ← → switch agent)", DIM)}`,
      `  ${tabs}`,
      "  " + style("─".repeat(Math.max(10, Math.min(cols - 4, 76))), DIM, FG.gray),
      "",
    ];

    items.forEach((item, idx) => {
      const isCursor = idx === selectedIndex;
      const isCurrent = item.id === activeModel;
      const mark = isCurrent ? "●" : "○";
      const note = item.note ? `  ${item.note}` : "";
      const rowText = ` ${isCursor ? "▸" : " "} ${mark} ${item.label.padEnd(24)}${note}`;
      if (isCursor) {
        lines.push(
          "  " +
            truncateVisible(
              `${agentBg(agent)}${FG.black}${BOLD}${rowText}${RESET}`,
              cols - 4,
            ),
        );
      } else {
        const markStyled = isCurrent ? style(mark, FG.brightGreen) : style(mark, DIM);
        lines.push(
          "  " +
            truncateVisible(
              `   ${markStyled} ${style(item.label.padEnd(24), FG.brightWhite)}${style(note, DIM)}`,
              cols - 4,
            ),
        );
      }
    });

    lines.push("");
    lines.push(
      "  " +
        style(
          "Enter: use for session  •  S: save as default in ~/.mcli/config.json  •  Esc: close",
          DIM,
          FG.cyan,
        ),
    );
    lines.push(
      "  " +
        style(
          "Tip: You can also type `/model <any-custom-name>` or inline `--claude:opus <prompt>`.",
          DIM,
        ),
    );
    lines.push("");
    return lines;
  }

  private styleInputLine(raw: string): string {
    // Highlight /commands, --agent[:model] / --agent --<model>, and --discuss / --agent discussion anywhere in the line
    if (raw.startsWith("/")) {
      const spaceIdx = raw.search(/\s/);
      if (spaceIdx === -1) return style(raw, FG.brightCyan, BOLD);
      return style(raw.slice(0, spaceIdx), FG.brightCyan, BOLD) + raw.slice(spaceIdx);
    }

    let out = raw.replace(
      /(^|\s)(--agent\s+discussion|--agent-discussion|--discuss(?:ion)?|--no-discuss(?:ion)?|--debate|--models|--skills|--skill(?:=\S+|\s+\S+)?|--no-synthesis|--rounds(?:=\d+|\s+\d+)?)(?=\s|$)/gi,
      (_m, lead: string, flag: string) => `${lead}${style(flag, FG.brightCyan, BOLD)}`,
    );

    out = out.replace(
      /(^|\s)(\$[a-zA-Z0-9][a-zA-Z0-9._-]*)(?=\s|$)/g,
      (_m, lead: string, tok: string) => `${lead}${style(tok, FG.brightGreen, BOLD)}`,
    );

    out = out.replace(
      /(^|\s)(--|@)(claude|codex|agy|deepseek|kimi)(:\S+)?(?=\s|$)/gi,
      (_m, lead: string, prefix: string, name: string, modelPart?: string) => {
        const id = name.toLowerCase() as AgentId;
        const base = style(`${prefix}${name}`, agentFg(id), BOLD);
        return modelPart ? `${lead}${base}${style(modelPart, FG.brightWhite, BOLD)}` : `${lead}${base}`;
      },
    );

    return out;
  }

  private render(): void {
    const cols = Math.max(40, process.stdout.columns || 80);
    const rows = Math.max(12, process.stdout.rows || 24);

    const headerLines = this.buildHeaderLines(cols); // 3 rows
    this.lastHeaderHeight = headerLines.length;
    const footerHeight = 3; // divider + input + hint
    const viewportHeight = Math.max(4, rows - headerLines.length - footerHeight);
    this.lastViewportHeight = viewportHeight;

    const contentLines = this.modelPicker
      ? this.buildModelPickerLines(cols)
      : this.buildConversationLines(cols);
    this.lastTotalLines = contentLines.length;
    this.lastPlainLines = contentLines.map((l) => stripAnsi(truncateVisible(l, cols)));

    const effectiveScroll = this.modelPicker ? 0 : this.scrollOffset;
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (!this.modelPicker && this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }

    const endIdx = this.modelPicker
      ? Math.min(contentLines.length, viewportHeight)
      : contentLines.length - effectiveScroll;
    const startIdx = this.modelPicker ? 0 : Math.max(0, endIdx - viewportHeight);
    this.lastStartIdx = startIdx;

    const normSel = !this.modelPicker && this.selection ? normalizeSelection(this.selection) : null;
    const visibleLines = contentLines.slice(startIdx, endIdx).map((rawLine, idx) => {
      const absLine = startIdx + idx;
      const truncated = truncateVisible(rawLine, cols);
      if (normSel && absLine >= normSel.startLine && absLine <= normSel.endLine) {
        const plainLen = this.lastPlainLines[absLine]?.length ?? 0;
        const sCol = absLine === normSel.startLine ? normSel.startCol : 0;
        const eCol = absLine === normSel.endLine ? normSel.endCol : Math.max(0, plainLen - 1);
        if (plainLen > 0) {
          return highlightVisibleRange(truncated, sCol, eCol);
        }
      }
      return truncated;
    });

    while (visibleLines.length < viewportHeight) {
      visibleLines.push("");
    }

    // Footer divider with status indicator on the right
    const statusRight = this.modelPicker
      ? style(` Selecting model for --${this.modelPicker.agent} `, agentFg(this.modelPicker.agent))
      : this.activeController
        ? style(" Streaming… (Ctrl+C / Esc to cancel) ", FG.brightYellow)
        : this.scrollOffset > 0
          ? style(` ↑ Scrolled +${this.scrollOffset}L (PgDn to jump down) `, FG.brightCyan)
          : style(` Ready · --${this.activeAgent} `, agentFg(this.activeAgent));
    const statusLen = stripAnsi(statusRight).length;
    const leftRule = Math.max(2, cols - statusLen);
    const footerDivider = style("─".repeat(leftRule), DIM, FG.gray) + statusRight;

    // Prompt input line with horizontal windowing if input exceeds terminal width
    const prefixPlain = `[--${this.activeAgent}] ❯ `;
    const prefixStyled = `${agentFg(this.activeAgent)}${BOLD}[--${this.activeAgent}]${RESET} ${style("❯", BOLD, FG.brightWhite)} `;
    const availableInputWidth = Math.max(10, cols - prefixPlain.length - 1);

    let windowStart = 0;
    if (this.cursor > availableInputWidth - 2) {
      windowStart = this.cursor - (availableInputWidth - 2);
    }
    this.lastInputPrefixLen = prefixPlain.length;
    this.lastInputWindowStart = windowStart;
    const visibleInput = this.input.slice(windowStart, windowStart + availableInputWidth);
    const styledInput =
      windowStart === 0 ? this.styleInputLine(visibleInput) : visibleInput;

    const suggestion = this.getAutocompleteSuggestion();
    let ghostSuffix = "";
    if (suggestion && windowStart === 0 && suggestion.length <= availableInputWidth) {
      ghostSuffix = style(suggestion.slice(this.input.length), DIM, FG.gray);
    }

    const inputRow = `${prefixStyled}${styledInput}${ghostSuffix}`;

    // Hint / notice bar
    const now = Date.now();
    let hintText: string;
    if (this.modelPicker) {
      hintText = style(
        " ↑/↓: move  •  Tab/←/→: agent  •  Enter: apply  •  S: save default  •  Esc: close",
        FG.brightCyan,
      );
    } else if (this.notice && now < this.noticeExpiresAt) {
      hintText = style(` ${this.notice}`, FG.brightCyan);
    } else if (suggestion) {
      hintText = style(` Tab: complete "${suggestion.trim()}"`, DIM, FG.cyan);
    } else {
      hintText = style(
        " Drag/2x-click: select & copy  •  Cmd+V/Ctrl+V: paste  •  Ctrl+O: models  •  /help",
        DIM,
      );
    }
    const hintRow = truncateVisible(hintText, cols);

    const frameRows = [
      ...headerLines,
      ...visibleLines.map((l) => padRightVisible(l, cols)),
      footerDivider,
      inputRow,
      hintRow,
    ];

    // Paint entire frame in a single write to eliminate flicker
    let out = "\x1b[?25l\x1b[H";
    for (let r = 0; r < frameRows.length; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K${frameRows[r]}`;
    }

    // Position real terminal cursor inside the input row (hide while model picker is open)
    const inputRowIndex = headerLines.length + viewportHeight + 2; // 1-based row
    this.lastInputRowIndex = inputRowIndex;
    if (!this.modelPicker) {
      const cursorCol = Math.min(cols, prefixPlain.length + (this.cursor - windowStart) + 1);
      out += `\x1b[${inputRowIndex};${cursorCol}H\x1b[?25h`;
    }

    process.stdout.write(out);
  }
}
