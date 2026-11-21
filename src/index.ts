import { detectAllAgents, pickInitialAgent } from "./adapters/index.ts";
import { parseCliArgs } from "./cli-args.ts";
import { createDefaultConfig, getConfigPath, loadConfig, saveConfig } from "./config.ts";
import { loadOrCreateSession } from "./session.ts";
import { AGENT_IDS } from "./types.ts";
import { BOLD, DIM, FG, style } from "./ui/ansi.ts";
import { formatDoctorReport, runOneShot, runPlainRepl } from "./ui/plain-repl.ts";
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
    '  mcli --claude "explain src/index.ts"       One-shot headless query (saves to shared history)',
    '  mcli --codex "write tests for it"          Follow up with Codex using shared context',
    '  mcli --claude --deepseek "compare ideas"   Run multiple agents together',
    '  git diff | mcli --agy "review this diff"   Pipe stdin directly to any agent',
    "",
    style("Options:", BOLD),
    "  -m, --model <name>     Override model for the active/selected agent",
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

  // One-shot mode if user passed a prompt or piped stdin
  if (combinedPrompt.length > 0) {
    const targetAgents = args.agents.length > 0 ? args.agents : [initialAgent];
    const exitCode = await runOneShot({
      agents: targetAgents,
      prompt: combinedPrompt,
      config,
      session,
      cwd,
      modelOverride: args.model,
      noContext: args.noContext,
      saveToSession: true,
    });
    process.exitCode = exitCode;
    return;
  }

  // Interactive mode: Plain REPL if --plain or non-TTY, else full Unified Chat TUI
  if (args.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    await runPlainRepl({
      config: args.noContext ? { ...config, shareContext: false } : config,
      session,
      cwd,
      initialAgent,
      modelOverride: args.model,
    });
    return;
  }

  const tui = new UnifiedChatTui({
    config: args.noContext ? { ...config, shareContext: false } : config,
    session,
    cwd,
    initialAgent,
    modelOverride: args.model,
  });
  await tui.start();
}

export { getConfigPath };
