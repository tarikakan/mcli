# mcli

**Unified Multi-Agent Chat TUI & CLI** combining **Claude**, **Codex**, **Agy**, **DeepSeek**, and **Kimi** in a single terminal window with **shared conversation history** and simple `--agent` flags.

## Features

- **All 5 agents in one window** via simple flags: `--claude`, `--codex`, `--agy`, `--deepseek`, `--kimi`
- **Shared conversation history & cross-agent context handoff**: ask `--claude` to inspect code, then immediately type `--codex fix the issue` or `--deepseek review the tradeoffs` — every agent receives the shared context automatically
- **Parallel multi-agent prompts**: pass multiple flags (e.g. `--claude --codex compare these approaches`) to stream responses from multiple agents side-by-side in the same conversation
- **Live streaming TUI**: sticky agent status bar, Markdown rendering, tool call & reasoning indicators, scrollable viewport, prompt history, inline flag autocomplete, and `Ctrl+C` cancellation without quitting
- **One-shot & piped CLI mode**: works seamlessly in shell pipelines (`git diff | mcli --claude "review this"`)
- **Local CLI auto-detection + built-in DeepSeek Streaming API fallback**: uses local binaries (`claude`, `codex`, `agy`, `kimi`, `deepseek`/`dsh`) and automatically falls back to DeepSeek's streaming API (`DEEPSEEK_API_KEY`) if no `deepseek` CLI is installed

## Requirements

- Node.js `>= 22.18.0` (runs TypeScript natively with zero runtime dependencies)

## Install Globally (`mcli`)

```bash
cd /Users/tarikak/Desktop/codes/mcli
npm link
```

Verify installation and check detected CLIs:

```bash
mcli --status
```

## Usage

### 1. Unified Interactive Chat TUI

```bash
mcli                 # Launch TUI with default/first available agent
mcli --codex         # Launch TUI with Codex selected
mcli --claude -s ui  # Resume or create a named shared session "ui"
```

Inside the TUI:

- Type `--codex fix the failing tests` → routes that turn to Codex (carrying shared history)
- Type `--claude` (alone) → switches the active default agent to Claude
- Type `--agy explain what Codex just did` → hands off to Agy with full shared context
- Type `--claude --deepseek compare both options` → runs both agents in parallel
- `@claude`, `@codex`, `@agy`, `@deepseek`, `@kimi` also work as aliases

**Keyboard Shortcuts:**

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Autocomplete `--flags` / `/commands`, or cycle active agent |
| `PgUp` / `PgDn` or `Alt+Up` / `Alt+Down` | Scroll chat history |
| `Up` / `Down` | Navigate prompt history |
| `Ctrl+C` / `Esc` | Cancel active streaming agent without exiting |
| `Ctrl+D` or `/exit` | Exit `mcli` |

**Slash Commands:**

- `/help` — Show flags, shortcuts, and commands
- `/status` — Show detection status of all 5 agents
- `/clear` — Clear shared conversation history
- `/history` — Summarize turns in the current session
- `/context [on|off]` — Toggle cross-agent context passing
- `/model <name|default>` — Override model for the active agent
- `/session [list|load <name>|new <name>]` — Switch or list persistent sessions
- `/copy` — Copy the last assistant response to clipboard
- `/export [file.md]` — Export full conversation to Markdown
- `/config` — Show config file location

### 2. One-Shot & Piped CLI Mode

```bash
mcli --claude "explain src/index.ts"
mcli --codex "write unit tests for the parser"
mcli --agy "refactor the config loader"
mcli --deepseek "compare SQLite vs JSON storage here"
mcli --kimi "summarize recent changes"

# Multi-agent comparison
mcli --claude --deepseek "what is the best caching strategy here?"

# Pipe stdin
git diff | mcli --claude "review these changes for bugs"
```

## Configuration (`~/.mcli/config.json`)

Generate a config file with defaults:

```bash
mcli --init-config
```

Example `~/.mcli/config.json`:

```json
{
  "defaultAgent": "claude",
  "shareContext": true,
  "maxContextTurns": 12,
  "maxContextChars": 24000,
  "agents": {
    "claude": {
      "enabled": true,
      "outputMode": "stream-json",
      "extraArgs": ["--permission-mode", "acceptEdits"]
    },
    "codex": {
      "enabled": true,
      "outputMode": "stream-json",
      "extraArgs": []
    },
    "agy": {
      "enabled": true,
      "outputMode": "stream-json",
      "extraArgs": []
    },
    "deepseek": {
      "enabled": true,
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com"
    },
    "kimi": {
      "enabled": true,
      "outputMode": "stream-json",
      "extraArgs": []
    }
  }
}
```

### DeepSeek Setup

`--deepseek` checks in order:
1. Custom `agents.deepseek.command` in `~/.mcli/config.json`
2. Local `deepseek` or `dsh` binary on `PATH`
3. Built-in DeepSeek Streaming API using `DEEPSEEK_API_KEY` (or `agents.deepseek.apiKey` in config). Supports both `deepseek-chat` and `deepseek-reasoner` (with live reasoning streaming).

## Tests

```bash
npm test
```
