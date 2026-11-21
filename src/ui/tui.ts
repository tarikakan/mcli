import fs from "node:fs";
import path from "node:path";
import { detectAllAgents, getAdapter } from "../adapters/index.ts";
import { parseInlineInput } from "../cli-args.ts";
import { getConfigPath } from "../config.ts";
import {
  buildPromptWithContext,
  createMessageId,
  exportSessionMarkdown,
  listSessions,
  loadOrCreateSession,
  saveSession,
} from "../session.ts";
import { AGENT_IDS, AGENT_META } from "../types.ts";
import type {
  AgentAvailability,
  AgentId,
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
  formatDuration,
  padRightVisible,
  renderMarkdownLines,
  stripAnsi,
  style,
  truncateVisible,
  wrapPlainText,
} from "./ansi.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SLASH_COMMANDS = [
  "/help",
  "/status",
  "/agents",
  "/clear",
  "/history",
  "/context",
  "/model",
  "/session",
  "/copy",
  "/export",
  "/config",
  "/exit",
];

interface LiveStream {
  agent: AgentId;
  model?: string;
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
}

export class UnifiedChatTui {
  private config: McliConfig;
  private session: SessionData;
  private cwd: string;
  private activeAgent: AgentId;
  private availability: Record<AgentId, AgentAvailability>;
  private modelOverrides: Partial<Record<AgentId, string>> = {};
  private shareContext: boolean;

  private input = "";
  private cursor = 0;
  private promptHistory: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";

  private scrollOffset = 0; // 0 = pinned to bottom; >0 = scrolled up by N lines
  private lastTotalLines = 0;
  private lastViewportHeight = 10;

  private activeController: AbortController | null = null;
  private liveStreams: LiveStream[] = [];
  private spinnerIdx = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;

  private notice = "";
  private noticeExpiresAt = 0;
  private lastCtrlCAt = 0;
  private renderScheduled = false;
  private running = false;
  private resolveExit: (() => void) | null = null;

  constructor(opts: TuiOptions) {
    this.config = opts.config;
    this.session = opts.session;
    this.cwd = opts.cwd;
    this.activeAgent = opts.initialAgent;
    this.shareContext = opts.config.shareContext;
    this.availability = detectAllAgents(opts.config);
    if (opts.modelOverride) {
      this.modelOverrides[this.activeAgent] = opts.modelOverride;
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

  private enterAltScreen(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25h\x1b[2J\x1b[H");
  }

  private leaveAltScreen(): void {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
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

    const tokenMatch = beforeCursor.match(/(?:^|\s)((?:--|@)[a-zA-Z]*)$/);
    if (tokenMatch) {
      const prefix = tokenMatch[1];
      const lead = prefix.startsWith("--") ? "--" : "@";
      const partial = prefix.slice(lead.length).toLowerCase();
      const matched = AGENT_IDS.find((id) => id.startsWith(partial) && id !== partial);
      if (matched) {
        return beforeCursor.slice(0, beforeCursor.length - prefix.length) + lead + matched + " ";
      }
    }

    return undefined;
  }

  private handleInputChunk(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];

      // Escape sequences (arrows, PgUp/PgDn, Home/End, Delete, Shift+Tab, Alt+keys)
      if (ch === "\x1b") {
        const rest = chunk.slice(i);

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

        // Plain Esc: abort active stream or clear input
        if (this.activeController) {
          this.activeController.abort();
          this.setNotice("Cancelling active agent run…");
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

    if (parsed.switchOnly) {
      const target = parsed.agents[0];
      this.activeAgent = target;
      this.session.activeAgent = target;
      saveSession(this.session);
      this.setNotice(`Active agent switched to --${target} (${AGENT_META[target].label})`, 2500);
      return;
    }

    if (this.activeController) {
      this.setNotice("An agent is currently streaming. Press Ctrl+C or Esc to cancel first.", 2500);
      this.input = raw;
      this.cursor = raw.length;
      return;
    }

    this.promptHistory.push(trimmed);
    const targets: AgentId[] = parsed.agents.length > 0 ? parsed.agents : [this.activeAgent];

    // If user routed with a single --agent flag, also make it the active agent for follow-ups
    if (parsed.agents.length === 1) {
      this.activeAgent = parsed.agents[0];
      this.session.activeAgent = this.activeAgent;
    }

    await this.dispatchAgents(targets, parsed.prompt);
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
            "- `--codex` alone switches the active default agent",
            "- `--claude --codex <prompt>` runs multiple agents in parallel in the same window",
            "- `@claude`, `@codex`, etc. also work as shortcuts",
            "",
            "**Shortcuts:**",
            "- `Tab` / `Shift+Tab`: autocomplete `--flags` or `/commands`, or cycle active agent",
            "- `PgUp` / `PgDn` or `Alt+Up` / `Alt+Down`: scroll conversation",
            "- `Up` / `Down`: prompt history",
            "- `Ctrl+C` / `Esc`: cancel active streaming response without quitting",
            "",
            "**Slash Commands:**",
            "- `/status` — detect all 5 CLIs & API fallback status",
            "- `/clear` — reset shared conversation history",
            "- `/context [on|off]` — toggle cross-agent context sharing",
            "- `/model <name|default>` — override model for active agent",
            "- `/session [list|load <name>|new <name>]` — manage sessions",
            "- `/copy` — copy last assistant response to clipboard",
            "- `/export [file.md]` — export conversation to Markdown",
            "- `/config` — show config file path",
            "- `/exit` — quit mcli",
          ].join("\n"),
        );
        return;

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
        saveSession(this.session);
        this.scrollOffset = 0;
        this.setNotice("Cleared shared conversation history.");
        return;

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
        if (args === "on") this.shareContext = true;
        else if (args === "off") this.shareContext = false;
        else this.shareContext = !this.shareContext;
        this.setNotice(
          `Shared cross-agent context is now ${this.shareContext ? "ON" : "OFF"} (max ${this.config.maxContextTurns} turns).`,
        );
        return;

      case "model":
        if (!args || args === "default") {
          delete this.modelOverrides[this.activeAgent];
          this.setNotice(`Reset model override for --${this.activeAgent}.`);
        } else {
          this.modelOverrides[this.activeAgent] = args;
          this.setNotice(`Set --${this.activeAgent} model to ${args}.`);
        }
        return;

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
              lines.push(`- \`${s.id}\`${mark} — ${s.messageCount} msgs (${s.cwd})`);
            }
            this.addSystemMessage(lines.join("\n"));
          }
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
        this.setNotice("Usage: /session [list | load <name> | new <name>]");
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

  private async dispatchAgents(agents: AgentId[], userPrompt: string): Promise<void> {
    const historySnapshot = [...this.session.messages];

    const userMsg: ChatMessage = {
      id: createMessageId(),
      role: "user",
      agent: agents[0],
      content: userPrompt,
      timestamp: new Date().toISOString(),
    };
    this.session.messages.push(userMsg);
    this.scrollOffset = 0;

    const controller = new AbortController();
    this.activeController = controller;
    this.liveStreams = agents.map((agent) => ({
      agent,
      model: this.modelOverrides[agent] ?? this.config.agents[agent]?.model,
      text: "",
      reasoning: "",
      tools: [],
      startedAt: Date.now(),
      done: false,
    }));

    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
      this.scheduleRender();
    }, 90);

    this.scheduleRender();

    const effectiveConfig = { ...this.config, shareContext: this.shareContext };

    try {
      const results = await Promise.all(
        agents.map(async (agent, idx) => {
          const stream = this.liveStreams[idx];
          const adapter = getAdapter(agent);
          const agentConfig = this.config.agents[agent] ?? {};

          const fullPrompt = buildPromptWithContext({
            userPrompt,
            history: historySnapshot,
            targetAgent: agent,
            config: effectiveConfig,
          });

          const res = await adapter.run({
            prompt: fullPrompt,
            rawUserPrompt: userPrompt,
            history: historySnapshot,
            cwd: this.cwd,
            model: this.modelOverrides[agent],
            sessionId: this.session.agentSessions[agent],
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
            this.session.agentSessions[agent] = res.sessionId;
          }
          this.scheduleRender();

          return { agent, res };
        }),
      );

      for (const { agent, res } of results) {
        const agentConfig = this.config.agents[agent] ?? {};
        this.session.messages.push({
          id: createMessageId(),
          role: "assistant",
          agent,
          model: this.modelOverrides[agent] ?? agentConfig.model,
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
    } finally {
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      this.activeController = null;
      this.liveStreams = [];
      this.scheduleRender();
    }
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
    const modelPart = activeModel ? `  •  model: ${activeModel}` : "";
    const ctxPart = `context: ${this.shareContext ? "on" : "off"} (${msgCount} msgs)`;
    const row2 = truncateVisible(
      style(
        ` dir: ${dirName}  •  session: ${this.session.name}  •  ${ctxPart}${modelPart}  •  Tab: cycle  •  /help`,
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
        const targetSuffix = msg.agent
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
        const durStr = msg.durationMs !== undefined ? style(` · ${formatDuration(msg.durationMs)}`, DIM) : "";
        const abortStr = msg.aborted ? style(" · cancelled", FG.yellow) : "";
        lines.push(`  ${agentBadge(agent, false)}${modelStr}${durStr}${abortStr}`);

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
      lines.push(
        `  ${spin} ${agentBadge(stream.agent, true)}${modelStr} ${style(stream.done ? `done (${elapsed})` : `streaming… ${elapsed}`, DIM)}`,
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

  private styleInputLine(raw: string): string {
    // Highlight leading --agent / @agent flags or /command in the prompt box
    if (raw.startsWith("/")) {
      const spaceIdx = raw.search(/\s/);
      if (spaceIdx === -1) return style(raw, FG.brightCyan, BOLD);
      return style(raw.slice(0, spaceIdx), FG.brightCyan, BOLD) + raw.slice(spaceIdx);
    }

    return raw.replace(
      /^((?:(?:--(?:claude|codex|agy|deepseek|kimi)|@(?:claude|codex|agy|deepseek|kimi))\s*)+)/i,
      (matched) =>
        matched.replace(/(--|@)(claude|codex|agy|deepseek|kimi)/gi, (tok, _p, name: string) => {
          const id = name.toLowerCase() as AgentId;
          return style(tok, agentFg(id), BOLD);
        }),
    );
  }

  private render(): void {
    const cols = Math.max(40, process.stdout.columns || 80);
    const rows = Math.max(12, process.stdout.rows || 24);

    const headerLines = this.buildHeaderLines(cols); // 3 rows
    const footerHeight = 3; // divider + input + hint
    const viewportHeight = Math.max(4, rows - headerLines.length - footerHeight);
    this.lastViewportHeight = viewportHeight;

    const contentLines = this.buildConversationLines(cols);
    this.lastTotalLines = contentLines.length;

    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }

    const endIdx = contentLines.length - this.scrollOffset;
    const startIdx = Math.max(0, endIdx - viewportHeight);
    const visibleLines = contentLines.slice(startIdx, endIdx);

    while (visibleLines.length < viewportHeight) {
      visibleLines.push("");
    }

    // Footer divider with status indicator on the right
    const statusRight = this.activeController
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
    if (this.notice && now < this.noticeExpiresAt) {
      hintText = style(` ${this.notice}`, FG.brightCyan);
    } else if (suggestion) {
      hintText = style(` Tab: complete "${suggestion.trim()}"`, DIM, FG.cyan);
    } else {
      hintText = style(
        " Flags: --claude --codex --agy --deepseek --kimi  •  Tab: cycle agent  •  PgUp/PgDn: scroll  •  /help",
        DIM,
      );
    }
    const hintRow = truncateVisible(hintText, cols);

    const frameRows = [
      ...headerLines,
      ...visibleLines.map((l) => padRightVisible(truncateVisible(l, cols), cols)),
      footerDivider,
      inputRow,
      hintRow,
    ];

    // Paint entire frame in a single write to eliminate flicker
    let out = "\x1b[?25l\x1b[H";
    for (let r = 0; r < frameRows.length; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K${frameRows[r]}`;
    }

    // Position real terminal cursor inside the input row
    const inputRowIndex = headerLines.length + viewportHeight + 2; // 1-based row
    const cursorCol = Math.min(cols, prefixPlain.length + (this.cursor - windowStart) + 1);
    out += `\x1b[${inputRowIndex};${cursorCol}H\x1b[?25h`;

    process.stdout.write(out);
  }
}
