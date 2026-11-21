import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
import type { AgentId, ChatMessage, McliConfig, SessionData, ToolEvent } from "../types.ts";
import {
  BOLD,
  DIM,
  FG,
  RESET,
  agentBadge,
  agentFg,
  copyToClipboard,
  formatDuration,
  style,
} from "./ansi.ts";

export function formatDoctorReport(config: McliConfig): string {
  const availability = detectAllAgents(config);
  const lines: string[] = [
    "",
    `${style("mcli", BOLD, FG.brightWhite)} ${style("— Unified Multi-Agent CLI Status", DIM)}`,
    style("─".repeat(64), DIM, FG.gray),
  ];

  for (const id of AGENT_IDS) {
    const info = availability[id];
    const flag = AGENT_META[id].flag.padEnd(11);
    const statusIcon =
      info.mode === "cli"
        ? style("● CLI", BOLD, FG.brightGreen)
        : info.mode === "api"
          ? style("◌ API", BOLD, FG.brightCyan)
          : style("✕ OFF", BOLD, FG.brightRed);
    const defaultMark = config.defaultAgent === id ? style(" (default)", DIM, FG.yellow) : "";
    lines.push(
      `  ${agentFg(id)}${BOLD}${flag}${RESET} ${statusIcon}  ${info.detail}${defaultMark}`,
    );
  }

  lines.push(style("─".repeat(64), DIM, FG.gray));
  lines.push(`  ${style("Config:", DIM)} ${getConfigPath()}`);
  lines.push(
    `  ${style("Shared context:", DIM)} ${config.shareContext ? "enabled" : "disabled"} (max ${config.maxContextTurns} turns / ${config.maxContextChars} chars)`,
  );
  lines.push("");
  return lines.join("\n");
}

export interface OneShotOptions {
  agents: AgentId[];
  prompt: string;
  config: McliConfig;
  session: SessionData;
  cwd: string;
  modelOverride?: string;
  noContext?: boolean;
  saveToSession?: boolean;
}

export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const controller = new AbortController();
  const onSigInt = (): void => {
    controller.abort();
  };
  process.on("SIGINT", onSigInt);

  const effectiveConfig = opts.noContext
    ? { ...opts.config, shareContext: false }
    : opts.config;

  const historySnapshot = [...opts.session.messages];

  const userMsg: ChatMessage = {
    id: createMessageId(),
    role: "user",
    agent: opts.agents[0],
    content: opts.prompt,
    timestamp: new Date().toISOString(),
  };

  let hadError = false;
  const assistantMessages: ChatMessage[] = [];

  try {
    const multi = opts.agents.length > 1;
    const isTty = Boolean(process.stdout.isTTY);

    for (const agent of opts.agents) {
      if (controller.signal.aborted) break;

      const adapter = getAdapter(agent);
      const agentConfig = opts.config.agents[agent] ?? {};
      const fullPrompt = buildPromptWithContext({
        userPrompt: opts.prompt,
        history: historySnapshot,
        targetAgent: agent,
        config: effectiveConfig,
      });

      if (multi || isTty) {
        process.stderr.write(
          `\n${agentBadge(agent, true)} ${style(`--${agent}`, DIM)}${opts.modelOverride ? style(` (${opts.modelOverride})`, DIM) : ""}\n`,
        );
      }

      const tools: ToolEvent[] = [];
      let streamedAnyText = false;

      const result = await adapter.run({
        prompt: fullPrompt,
        rawUserPrompt: opts.prompt,
        history: historySnapshot,
        cwd: opts.cwd,
        model: opts.modelOverride,
        sessionId: opts.session.agentSessions[agent],
        config: agentConfig,
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === "text" && ev.text) {
            streamedAnyText = true;
            process.stdout.write(ev.text);
          } else if (ev.type === "tool" && ev.toolName && isTty) {
            const detail = ev.toolDetail ? `: ${ev.toolDetail}` : "";
            process.stderr.write(style(`  ⚙ ${ev.toolName}${detail}\n`, DIM, FG.cyan));
          } else if (ev.type === "error" && ev.text) {
            process.stderr.write(style(`\n[${agent} error] ${ev.text}\n`, FG.brightRed));
          }
        },
      });

      if (streamedAnyText && !result.text.endsWith("\n")) {
        process.stdout.write("\n");
      }

      if (result.sessionId) {
        opts.session.agentSessions[agent] = result.sessionId;
      }

      if (result.error) hadError = true;
      tools.push(...result.tools);

      assistantMessages.push({
        id: createMessageId(),
        role: "assistant",
        agent,
        model: opts.modelOverride ?? agentConfig.model,
        content: result.text,
        reasoning: result.reasoning || undefined,
        tools: tools.length > 0 ? tools : undefined,
        timestamp: new Date().toISOString(),
        durationMs: result.durationMs,
        error: result.error,
        aborted: result.aborted,
      });

      if (isTty) {
        process.stderr.write(style(`  (${formatDuration(result.durationMs)})\n`, DIM));
      }
    }

    if (opts.saveToSession !== false) {
      opts.session.messages.push(userMsg, ...assistantMessages);
      opts.session.activeAgent = opts.agents[opts.agents.length - 1] ?? opts.session.activeAgent;
      saveSession(opts.session);
    }
  } finally {
    process.off("SIGINT", onSigInt);
  }

  return hadError ? 1 : 0;
}

export interface PlainReplOptions {
  config: McliConfig;
  session: SessionData;
  cwd: string;
  initialAgent: AgentId;
  modelOverride?: string;
}

export async function runPlainRepl(opts: PlainReplOptions): Promise<void> {
  let activeAgent: AgentId = opts.initialAgent;
  let shareContext = opts.config.shareContext;
  const modelOverrides: Partial<Record<AgentId, string>> = {};
  if (opts.modelOverride) {
    modelOverrides[activeAgent] = opts.modelOverride;
  }

  console.log(formatDoctorReport(opts.config));
  console.log(
    style(
      `Plain REPL mode • session: ${opts.session.name} • prefix any prompt with --claude, --codex, --agy, --deepseek, or --kimi • /help for commands`,
      DIM,
    ),
  );
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) {
        resolve(null);
        return;
      }
      const onClose = (): void => resolve(null);
      rl.once("close", onClose);
      const promptLabel = `${agentFg(activeAgent)}${BOLD}[--${activeAgent}]${RESET} ❯ `;
      rl.question(promptLabel, (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      });
    });

  while (true) {
    const line = await ask();
    if (line === null) break;

    const parsed = parseInlineInput(line);
    if (!parsed.isSlashCommand && !parsed.switchOnly && !parsed.prompt) {
      continue;
    }

    if (parsed.isSlashCommand) {
      const cmd = parsed.command || "";
      const args = parsed.commandArgs || "";

      if (cmd === "exit" || cmd === "quit" || cmd === "q") {
        break;
      } else if (cmd === "help") {
        console.log(
          [
            "",
            style("Inline agent routing:", BOLD),
            "  --claude <prompt>   Route turn to Claude (or just `--claude` to switch default)",
            "  --codex <prompt>    Route turn to Codex",
            "  --agy <prompt>      Route turn to Agy",
            "  --deepseek <prompt> Route turn to DeepSeek",
            "  --kimi <prompt>     Route turn to Kimi",
            "  --claude --codex <prompt>  Ask multiple agents in one turn",
            "",
            style("Commands:", BOLD),
            "  /status, /clear, /history, /context [on|off], /model <name>, /session [list|load <name>], /copy, /export <file>, /exit",
            "",
          ].join("\n"),
        );
      } else if (cmd === "status" || cmd === "agents") {
        console.log(formatDoctorReport(opts.config));
      } else if (cmd === "clear") {
        opts.session.messages = [];
        opts.session.agentSessions = {};
        saveSession(opts.session);
        console.log(style("Cleared conversation history.", FG.green));
      } else if (cmd === "context") {
        if (args === "on") shareContext = true;
        else if (args === "off") shareContext = false;
        else shareContext = !shareContext;
        console.log(style(`Shared cross-agent context: ${shareContext ? "ON" : "OFF"}`, FG.cyan));
      } else if (cmd === "model") {
        if (!args || args === "default") {
          delete modelOverrides[activeAgent];
          console.log(style(`Reset model override for --${activeAgent}.`, FG.cyan));
        } else {
          modelOverrides[activeAgent] = args;
          console.log(style(`Set --${activeAgent} model override to ${args}.`, FG.cyan));
        }
      } else if (cmd === "history") {
        if (opts.session.messages.length === 0) {
          console.log(style("No messages yet.", DIM));
        } else {
          for (const msg of opts.session.messages) {
            const who = msg.role === "user" ? "You" : AGENT_META[msg.agent ?? "claude"].label;
            const preview = msg.content.replace(/\s+/g, " ").slice(0, 90);
            console.log(`  ${style(who, BOLD)}: ${preview}`);
          }
        }
      } else if (cmd === "session") {
        const [sub, name] = args.split(/\s+/);
        if (!sub || sub === "list") {
          const all = listSessions();
          for (const s of all.slice(0, 15)) {
            console.log(`  ${s.id} (${s.messageCount} msgs) — ${s.cwd}`);
          }
        } else if ((sub === "load" || sub === "new") && name) {
          opts.session = loadOrCreateSession({
            name,
            cwd: opts.cwd,
            activeAgent,
            fresh: sub === "new",
          });
          console.log(style(`Switched to session "${opts.session.name}" (${opts.session.messages.length} msgs).`, FG.green));
        }
      } else if (cmd === "copy") {
        const last = [...opts.session.messages].reverse().find((m) => m.role === "assistant" && m.content);
        if (!last) {
          console.log(style("No assistant message to copy.", FG.yellow));
        } else if (copyToClipboard(last.content)) {
          console.log(style("Copied last assistant response to clipboard.", FG.green));
        } else {
          console.log(style("Clipboard utility not available.", FG.yellow));
        }
      } else if (cmd === "export") {
        const filePath = path.resolve(opts.cwd, args || `${opts.session.id}.md`);
        fs.writeFileSync(filePath, exportSessionMarkdown(opts.session), "utf8");
        console.log(style(`Exported session to ${filePath}`, FG.green));
      } else {
        console.log(style(`Unknown command: /${cmd}. Type /help.`, FG.yellow));
      }
      continue;
    }

    if (parsed.switchOnly) {
      activeAgent = parsed.agents[0];
      opts.session.activeAgent = activeAgent;
      saveSession(opts.session);
      console.log(style(`Active agent switched to --${activeAgent} (${AGENT_META[activeAgent].label}).`, agentFg(activeAgent)));
      continue;
    }

    const targetAgents = parsed.agents.length > 0 ? parsed.agents : [activeAgent];
    if (parsed.agents.length === 1) {
      activeAgent = parsed.agents[0];
    }

    await runOneShot({
      agents: targetAgents,
      prompt: parsed.prompt,
      config: { ...opts.config, shareContext },
      session: opts.session,
      cwd: opts.cwd,
      modelOverride: targetAgents.length === 1 ? modelOverrides[targetAgents[0]] : undefined,
      saveToSession: true,
    });
  }

  rl.close();
}
