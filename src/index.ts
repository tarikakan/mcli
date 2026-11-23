import { detectAllAgents, pickInitialAgent } from "./adapters/index.ts";
import { parseCliArgs } from "./cli-args.ts";
import { createDefaultConfig, getConfigPath, loadConfig, saveConfig } from "./config.ts";
import { resolveModelAlias } from "./models.ts";
import { loadOrCreateSession } from "./session.ts";
import { AGENT_IDS } from "./types.ts";
import type { AgentId, AgentTarget } from "./types.ts";
import { BOLD, DIM, FG, style } from "./ui/ansi.ts";
import {
  formatDoctorReport,
  formatModelsReport,
  formatSkillsReport,
  runOneShot,
  runPlainRepl,
} from "./ui/plain-repl.ts";
import { UnifiedChatTui } from "./ui/tui.ts";

const VERSION = "0.1.0";

function printHelp(): void {
  const lines = [
    "",
    `${style("mcli", BOLD, FG.brightWhite)} ${style(`v${VERSION}`, DIM)} — Combine Claude, Codex, Agy, DeepSeek & Kimi in one CLI window`,
    "",
    style("Usage:", BOLD),
    "  mcli [agent-flags] [options] [prompt]",
    "",
    style("Agent Flags (work both on CLI and inline inside chat):", BOLD),
    "  --claude      Use Anthropic Claude Code CLI",
    "  --codex       Use OpenAI Codex CLI",
    "  --agy         Use Google Antigravity CLI",
    "  --deepseek    Use DeepSeek CLI (`deepseek`/`dsh`) or built-in streaming API",
    "  --kimi        Use Moonshot Kimi Code CLI",
    "",
    style("Examples:", BOLD),
    "  mcli                                       Open unified chat TUI",
    "  mcli --codex                               Open TUI starting on Codex",
    '  mcli --claude --opus "explain src/index.ts"  Pick firm + model with --agent --<model>',
    '  mcli --codex --gpt-5.6-sol --claude --opus --agent discussion "investigate heavy quarks"',
    '  mcli --claude:opus --deepseek:reasoner --discuss "compare designs"',
    '  git diff | mcli --agy "review this diff"   Pipe stdin directly to any agent',
    "",
    style("Options:", BOLD),
    "  -m, --model <name>     Override model for the active/selected agent",
    "  --models               List available & preset models for all (or selected) agents",
    "  --skills               List all SKILL.md skills across Claude, Codex, Agy, Kimi & workspace",
    "  --skill <name>         Apply any CLI's skill to any agent (repeatable; or inline $<name>)",
    "  --discuss, --agent discussion  Enable multi-round peer discussion + synthesis across 2+ agents",
    "  --rounds <N>           Number of discussion rounds (default: 2, max: 6)",
    "  --no-synthesis         Skip final consensus synthesis step after discussion rounds",
    "  --no-discuss           Force parallel-only mode even if discussion is enabled in config",
    "  -s, --session <name>   Load or create a named shared session",
    "  --new                  Start a fresh session (do not load previous workspace history)",
    "  --no-context           Disable cross-agent context injection for this run",
    "  --plain, --no-tui      Use plain scrolling REPL instead of full-screen TUI",
    "  --status, --doctor     Check availability of all 5 CLIs & DeepSeek API fallback",
    "  --init-config          Write default configuration to ~/.mcli/config.json",
    "  -v, --version          Show version",
    "  -h, --help             Show this help",
    "",
  ];
  console.log(lines.join("\n"));
}

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(argv: string[]): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    console.log(`mcli ${VERSION}`);
    return;
  }

  if (args.initConfig) {
    const cfg = createDefaultConfig();
    const savedPath = saveConfig(cfg);
    console.log(style(`Created config at ${savedPath}`, FG.brightGreen));
    return;
  }

  const config = loadConfig();

  if (args.status) {
    console.log(formatDoctorReport(config));
    return;
  }

  if (args.listModels) {
    console.log(await formatModelsReport(config, args.agents));
    return;
  }

  if (args.listSkills) {
    console.log(formatSkillsReport(process.cwd(), config));
    return;
  }

  if (args.unknownFlags.length > 0) {
    console.error(
      style(`Unknown flag(s): ${args.unknownFlags.join(", ")}`, FG.brightRed) +
        `\nAvailable agent flags: ${AGENT_IDS.map((id) => `--${id}`).join(", ")}\nRun \`mcli --help\` for usage.`,
    );
    process.exitCode = 2;
    return;
  }

  const cwd = process.cwd();
  const availability = detectAllAgents(config);
  const initialAgent = pickInitialAgent(config, availability, args.agents[0]);

  const session = loadOrCreateSession({
    name: args.session,
    cwd,
    activeAgent: initialAgent,
    fresh: args.newSession,
  });

  const pipedStdin = await readPipedStdin();
  const combinedPrompt = [
    args.prompt,
    pipedStdin ? `\n\n<stdin>\n${pipedStdin}\n</stdin>` : "",
  ]
    .join("")
    .trim();

  // Build concrete targets preserving multi-firm and same-firm multi-model selections
  const resolvedTargets: AgentTarget[] =
    args.targets.length > 0
      ? args.targets.map((t) => ({
          agent: t.agent,
          model: t.model ?? (args.model ? resolveModelAlias(t.agent, args.model) : undefined),
        }))
      : [
          {
            agent: initialAgent,
            model: args.model ? resolveModelAlias(initialAgent, args.model) : undefined,
          },
        ];

  // Merge global --model with per-agent --agent:model overrides for interactive startup
  const initialAgentModels: Partial<Record<AgentId, string>> = { ...args.agentModels };
  if (args.model) {
    const targets = args.agents.length > 0 ? args.agents : [initialAgent];
    for (const ag of targets) {
      if (!initialAgentModels[ag]) {
        initialAgentModels[ag] = resolveModelAlias(ag, args.model);
      }
    }
  }

  // One-shot mode if user passed a prompt or piped stdin
  if (combinedPrompt.length > 0) {
    const exitCode = await runOneShot({
      agents: resolvedTargets.map((t) => t.agent),
      targets: resolvedTargets,
      skills: args.skills,
      prompt: combinedPrompt,
      config,
      session,
      cwd,
      modelOverride: args.model,
      agentModels: initialAgentModels,
      discuss: args.discuss,
      discussionRounds: args.discussionRounds,
      synthesize: !args.noSynthesis,
      noContext: args.noContext,
      saveToSession: true,
    });
    process.exitCode = exitCode;
    return;
  }

  // If user launched interactive mode with --skill <name>, pin them for this session
  if (args.skills.length > 0) {
    const merged = new Set([...(session.pinnedSkills ?? []), ...args.skills]);
    session.pinnedSkills = Array.from(merged);
  }

  // Interactive mode: Plain REPL if --plain or non-TTY, else full Unified Chat TUI
  if (args.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    await runPlainRepl({
      config: args.noContext ? { ...config, shareContext: false } : config,
      session,
      cwd,
      initialAgent,
      modelOverride: args.model,
      agentModels: initialAgentModels,
      agentDiscussion: args.discuss,
      discussionRounds: args.discussionRounds,
    });
    return;
  }

  const tui = new UnifiedChatTui({
    config: args.noContext ? { ...config, shareContext: false } : config,
    session,
    cwd,
    initialAgent,
    modelOverride: args.model,
    agentModels: initialAgentModels,
    agentDiscussion: args.discuss,
    discussionRounds: args.discussionRounds,
  });
  await tui.start();
}

export { getConfigPath };
