# mcli

**Unified Multi-Agent Chat TUI & CLI** combining **Claude**, **Codex**, **Agy**, **DeepSeek**, and **Kimi** in a single terminal window with **shared conversation history** and simple `--agent` flags.

> **Docs (PDF):** [Full User Manual (`mcli-manual.pdf`)](./mcli-manual.pdf) · [2-Page Quick Cheat Sheet (`mcli-cheatsheet.pdf`)](./mcli-cheatsheet.pdf)

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
git clone https://github.com/tarikakan/mcli.git
cd mcli
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

| Key / Mouse | Action |
| --- | --- |
| **Click-drag** / **2x-click** / **3x-click** | Select any words, sentences, or multi-line blocks and **auto-copy to clipboard** |
| `Cmd+V` / `Ctrl+V` / Middle-click | Paste from clipboard cleanly at cursor (bracketed paste — won't auto-submit) |
| `Ctrl+Y` | Copy current selection (or last assistant response) |
| `Ctrl+O` | Open interactive **Model Picker** (`↑`/`↓` select, `Tab` switch agent, `S` save default) |
| `Tab` / `Shift+Tab` | Autocomplete `--flags`, `$skills`, `/commands`, or cycle active agent |
| Mouse wheel / `PgUp` / `PgDn` / `Alt+↑`/`↓` | Scroll chat history |
| `Up` / `Down` | Navigate prompt history |
| `Ctrl+C` / `Esc` | Cancel active streaming agent (or clear selection) without exiting |
| `Ctrl+D` or `/exit` | Exit `mcli` |

**Slash Commands:**

- `/model` or `/models` — Open the interactive model picker
- `/model <name>` — Override model for the active agent (or `/model <agent> <name>`, `/model default`, `/model save`)
- `/help` — Show flags, shortcuts, and commands
- `/status` — Show detection status of all 5 agents
- `/clear` — Clear shared conversation history
- `/history` — Summarize turns in the current session
- `/perm [read-only|edit|full]` — Control headless tool permissions (`edit` allows file writes by default; `full` / `--yolo` also allows shell commands like `cp`, `pdflatex`, `npm test`)
- `/allow [list|<dir>|remove <dir>|clear]` — Grant read/write access to external directories outside `cwd` (passed via `--add-dir` to Claude, Codex & Agy; also available as `--add-dir <dir>`). When an agent requests an external path or shell permission mid-discussion, `mcli` pauses and shows a live `[Y]` Approve once / `[A]` Allow for session / `[F]` Allow + full perm / `[N]` Decline prompt and immediately retries!
- `/skills` or `--skills` — List all `SKILL.md` skills across Claude, Codex, Agy, Kimi & workspace
- `/skill [use <name>|off <name>|clear|show <name>]` — Pin/unpin or inspect skills across all agents
- `/memory [status|set <agent[:model]|auto|local>|mode lean|balanced|full|auto on|off]` — Assign a cheap/fast Scribe agent to manage memory & save tokens
- `/compact [fast]` — Compress older turns via your Memory Scribe agent (keeps recent turns verbatim)
- `/context [on|off|show]` — Toggle or inspect 3-tier shared memory & token estimate
- `/session [list|save <name>|load <name>|new <name>]` — Snapshot, switch, or list persistent sessions
- `/copy` — Copy the last assistant response to clipboard
- `/export [file.md]` — Export full conversation to Markdown
- `/config` — Show config file location

### Dedicated Memory Scribe Agent & 3-Tier Shared Memory

To avoid burning expensive flagship tokens (`opus`, `gpt-5.6-sol`, etc.) on long transcripts, `mcli` puts a **cheap, fast Memory Scribe agent** in charge of compacting conversation memory automatically in the background:

- **Default auto-selection (cheapest available):** `deepseek:deepseek-chat` → `claude:haiku` → `agy:gemini-2.5-flash` → `codex:o4-mini` → `kimi:kimi-k2-turbo-preview` → `local` ($0 / 0 tokens).
- **Customize anytime inside TUI/REPL:**
  ```text
  /memory set claude:haiku       # Use Claude Haiku as your memory scribe
  /memory set deepseek:chat      # Use DeepSeek V3 (ultra-low cost)
  /memory set local              # Zero-token ($0) local deterministic digest
  /memory mode lean              # Summary + last 1 turn (~1.5k tokens max — lowest burn)
  /memory mode balanced          # Summary + last 2 turns (default)
  /memory auto on|off            # Toggle automatic background compaction
  ```
- **3-Tier Shared Memory:**
  1. **Tier 1 — Rolling Summary:** Scribe agent auto-compacts older turns into `session.summary` inside `~/.mcli/sessions/<id>.json`.
  2. **Tier 2 — Smart Discussion Folding:** Older multi-round discussions fold Round 1/2 drafts down to their **`Final Synthesis`** + participant list.
  3. **Tier 3 — Auto-Synced Markdown Transcript (`~/.mcli/sessions/<id>.md`):** Full verbatim log persisted alongside JSON so file-capable agents (`claude`, `codex`, `agy`, `kimi`) can read earlier details on demand.

### Multi-Firm / Multi-Model Jobs & Optional Agent Discussion

Combine multiple firms and specific models on a single job using either `--agent --<model>` or `--agent:<model>` syntax (anywhere in the prompt):

```bash
# Parallel independent responses from two firms + specific models
mcli --codex --gpt-5.6-sol --claude --opus "investigate the heavy quarks"

# Enable multi-round peer discussion + final consensus synthesis
mcli --codex --gpt-5.6-sol --claude --opus --agent discussion "investigate the heavy quarks"

# Equivalent shorthand with custom round count (default: 2 rounds + synthesis)
mcli --codex --gpt-5.6-sol --claude --opus --discuss --rounds 3 "investigate the heavy quarks"

# Even compare two models from the same firm
mcli --claude --opus --claude --sonnet --discuss "compare these two proofs"
```

**How Agent Discussion works (opt-in):**
- **Round 1 (Independent Analysis):** Each selected firm/model investigates the prompt independently so there is no anchoring bias.
- **Round 2..N (Peer Discussion):** Each agent reads the other agents' previous responses, challenges gaps/errors, incorporates valid points, and refines its answer.
- **Final Synthesis:** Produces a consolidated consensus summary (points of agreement, key disagreements, and final answer). Skip with `--no-synthesis`.
- **Toggleable default:** Use `/discuss on` (or `/discuss rounds 3`) inside the TUI, or set `"agentDiscussion": true` in `~/.mcli/config.json`. Override per job with `--discuss` / `--agent discussion` or `--no-discuss`.

### Unified Cross-CLI Skills (`--skills`, `--skill`, `$<name>`)

`mcli` automatically discovers your existing `SKILL.md` skills across `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.kimi/skills`, `~/.mcli/skills`, and workspace skill folders (plus custom `skillDirs` in `~/.mcli/config.json`) — so you can run **any Claude or Codex skill on any agent**, including DeepSeek and `--agent discussion`:

```bash
# List every discovered skill across all CLIs
mcli --skills

# Run a Claude skill on Codex (or vice versa, or on DeepSeek API)
mcli --codex --skill my-claude-skill "refactor this module"

# Share a skill across multiple firms & models in an agent discussion
mcli --codex --gpt-5.6-sol --claude --opus --skill my-skill --agent discussion "investigate..."
```

Inside the TUI:
- Type **`--skills`** or **`/skills`** to list all skills and their origin (`[claude]`, `[codex]`, `[workspace]`, etc.)
- Trigger inline with **`$<skill-name>`** (Tab-autocompletes!) or **`--skill <name>`**
- Pin skills for the whole session with **`/skill use <name>`** (clear with `/skill clear`)

### Choosing Models

There are 4 ways to choose models per agent:

1. **Interactive Model Picker (TUI):** Press `Ctrl+O` or type `/model` (or `/models`) inside the TUI. Use `↑`/`↓` to pick a model, `Tab` to switch between agents, `Enter` to apply for the session, or `S` to save as the permanent default in `~/.mcli/config.json`.
2. **Inline `--agent:model` syntax (TUI & CLI):**
   ```bash
   mcli --claude:opus "review this architecture"
   mcli --deepseek:reasoner "prove this invariant"
   mcli --claude:opus --codex:o3 "compare two implementations"
   ```
   *(Short aliases like `reasoner`/`r1` → `deepseek-reasoner`, `o`/`s`/`h` → `opus`/`sonnet`/`haiku`, `5.3` → `gpt-5.3-codex` are also expanded automatically.)*
3. **CLI `--model` / `-m` flag & `--models` list:**
   ```bash
   mcli --models                      # List preset & detected models for all agents
   mcli --claude --models             # List models for Claude
   mcli --codex -m o3 "fix tests"
   ```
4. **Persistent defaults & custom models in `~/.mcli/config.json`:**
   Set `agents.<id>.model` for a default model, or `agents.<id>.models: ["custom-model"]` to add custom models to the interactive picker.

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
