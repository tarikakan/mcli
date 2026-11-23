import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { detectAllAgents, getAdapter } from "../adapters/index.ts";
import { isAgentId, parseInlineInput } from "../cli-args.ts";
import { getConfigPath, saveConfig } from "../config.ts";
import { discoverAllAgentModels, discoverModelsForAgent, resolveModelAlias } from "../models.ts";
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

export async function formatModelsReport(
  config: McliConfig,
  filterAgents?: AgentId[],
): Promise<string> {
  const targets = filterAgents && filterAgents.length > 0 ? filterAgents : [...AGENT_IDS];
  const allModels = await discoverAllAgentModels(config, {
    agents: targets,
    forceRefresh: true,
  });
  const lines: string[] = [
    "",
    `${style("mcli", BOLD, FG.brightWhite)} ${style("— Models across CLIs", DIM)}`,
    style("─".repeat(68), DIM, FG.gray),
  ];

  for (const id of targets) {
    const configured = config.agents[id]?.model;
    const currentLabel = configured
      ? style(`default: ${configured}`, FG.brightCyan)
      : style("default: CLI default", DIM);
    lines.push(`  ${agentBadge(id, false)} ${style(`(--${id})`, DIM)}  ${currentLabel}`);
    for (const m of allModels[id]) {
      const activeMark = configured === m.id ? style("●", FG.brightGreen) : style("○", DIM);
      const sourceTag =
        m.source === "discovered"
          ? style(" [live]", FG.brightGreen)
          : m.source === "config"
            ? style(" [config]", FG.brightCyan)
            : "";
      const note = m.note ? style(` — ${m.note}`, DIM) : "";
      lines.push(`    ${activeMark} ${style(m.id, FG.brightWhite)}${sourceTag}${note}`);
    }
    lines.push("");
  }

  lines.push(style("─".repeat(68), DIM, FG.gray));
  lines.push(
    `  ${style("Quick select:", DIM)} ${style('mcli --claude:opus "..."', FG.brightWhite)}  or  ${style('mcli --deepseek --model deepseek-reasoner "..."', FG.brightWhite)}`,
  );
  lines.push(
    `  ${style("In TUI:", DIM)} type ${style("--models", BOLD)} for all CLIs, or press ${style("Ctrl+O", BOLD)} / ${style("/model", BOLD)} for the picker`,
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
  agentModels?: Partial<Record<AgentId, string>>;
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
      const resolvedModel =
        opts.agentModels?.[agent] ??
        (opts.modelOverride ? resolveModelAlias(agent, opts.modelOverride) : undefined);
      const fullPrompt = buildPromptWithContext({
        userPrompt: opts.prompt,
        history: historySnapshot,
        targetAgent: agent,
        config: effectiveConfig,
      });

      if (multi || isTty) {
        process.stderr.write(
          `\n${agentBadge(agent, true)} ${style(`--${agent}`, DIM)}${resolvedModel ? style(` (${resolvedModel})`, DIM) : ""}\n`,
        );
      }

      const tools: ToolEvent[] = [];
      let streamedAnyText = false;

      const result = await adapter.run({
        prompt: fullPrompt,
        rawUserPrompt: opts.prompt,
        history: historySnapshot,
        cwd: opts.cwd,
        model: resolvedModel,
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
        model: resolvedModel ?? agentConfig.model,
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
  agentModels?: Partial<Record<AgentId, string>>;
}

export async function runPlainRepl(opts: PlainReplOptions): Promise<void> {
  let activeAgent: AgentId = opts.initialAgent;
  let shareContext = opts.config.shareContext;
  const modelOverrides: Partial<Record<AgentId, string>> = { ...opts.agentModels };
  if (opts.modelOverride) {
    modelOverrides[activeAgent] = resolveModelAlias(activeAgent, opts.modelOverride);
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
    if (!parsed.isSlashCommand && !parsed.listModels && !parsed.switchOnly && !parsed.prompt) {
      continue;
    }

    if (parsed.listModels) {
      console.log(await formatModelsReport(opts.config, parsed.agents));
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
      } else if (cmd === "models") {
        const filter = args
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => t.replace(/^--/, "").toLowerCase())
          .filter(isAgentId);
        console.log(await formatModelsReport(opts.config, filter));
      } else if (cmd === "model") {
        const parts = args.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          const models = await discoverModelsForAgent(activeAgent, opts.config.agents[activeAgent] ?? {}, true);
          const cur = modelOverrides[activeAgent] ?? opts.config.agents[activeAgent]?.model ?? "(CLI default)";
          console.log(`\n${agentBadge(activeAgent, false)} current model: ${style(cur, BOLD)}`);
          for (const m of models) {
            console.log(`  - ${style(m.id, FG.brightWhite)}${m.note ? style(` — ${m.note}`, DIM) : ""}`);
          }
          console.log(style("  Use `/model <name>`, `/model <agent> <name>`, `/model default`, `/model save`, or `--models` for all CLIs.\n", DIM));
        } else if (parts[0] === "save") {
          for (const id of AGENT_IDS) {
            if (modelOverrides[id] !== undefined) {
              opts.config.agents[id] = { ...opts.config.agents[id], model: modelOverrides[id] };
            }
          }
          const savedPath = saveConfig(opts.config);
          console.log(style(`Saved model defaults to ${savedPath}`, FG.green));
        } else if (parts.length >= 2 && isAgentId(parts[0].toLowerCase())) {
          const target = parts[0].toLowerCase() as AgentId;
          const val = parts.slice(1).join(" ");
          if (val === "default") {
            delete modelOverrides[target];
            console.log(style(`Reset model override for --${target}.`, FG.cyan));
          } else {
            const resolved = resolveModelAlias(target, val);
            modelOverrides[target] = resolved;
            console.log(style(`Set --${target} model to ${resolved}.`, FG.cyan));
          }
        } else if (parts[0] === "default") {
          delete modelOverrides[activeAgent];
          console.log(style(`Reset model override for --${activeAgent}.`, FG.cyan));
        } else {
          const resolved = resolveModelAlias(activeAgent, parts.join(" "));
          modelOverrides[activeAgent] = resolved;
          console.log(style(`Set --${activeAgent} model to ${resolved}.`, FG.cyan));
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
      if (parsed.agents.length > 0) {
        activeAgent = parsed.agents[0];
        opts.session.activeAgent = activeAgent;
      }
      for (const [ag, mod] of Object.entries(parsed.agentModels)) {
        if (mod) modelOverrides[ag as AgentId] = mod;
      }
      if (parsed.modelOverride) {
        modelOverrides[activeAgent] = resolveModelAlias(activeAgent, parsed.modelOverride);
      }
      saveSession(opts.session);
      const modLabel = modelOverrides[activeAgent] ? ` (model: ${modelOverrides[activeAgent]})` : "";
      console.log(
        style(
          `Active agent: --${activeAgent} (${AGENT_META[activeAgent].label})${modLabel}`,
          agentFg(activeAgent),
        ),
      );
      continue;
    }

    const targetAgents = parsed.agents.length > 0 ? parsed.agents : [activeAgent];
    if (parsed.agents.length === 1) {
      activeAgent = parsed.agents[0];
    }

    const turnModels: Partial<Record<AgentId, string>> = {};
    for (const ag of targetAgents) {
      const m =
        parsed.agentModels[ag] ??
        (parsed.modelOverride ? resolveModelAlias(ag, parsed.modelOverride) : undefined) ??
        modelOverrides[ag];
      if (m) turnModels[ag] = m;
    }

    await runOneShot({
      agents: targetAgents,
      prompt: parsed.prompt,
      config: { ...opts.config, shareContext },
      session: opts.session,
      cwd: opts.cwd,
      agentModels: turnModels,
      saveToSession: true,
    });
  }

  rl.close();
}
