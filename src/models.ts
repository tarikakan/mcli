import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBinary } from "./config.ts";
import { AGENT_IDS } from "./types.ts";
import type { AgentConfig, AgentId, McliConfig } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface ModelOption {
  id: string;
  label?: string;
  note?: string;
  source: "preset" | "config" | "discovered";
}

export interface DiscoveredModel {
  id: string;
  note?: string;
}

const DEFAULT_PRESETS: Record<AgentId, Array<{ id: string; note: string }>> = {
  claude: [
    { id: "sonnet", note: "Balanced coding & daily work (latest Sonnet)" },
    { id: "opus", note: "Deep reasoning & complex architecture (latest Opus)" },
    { id: "haiku", note: "Fast, lightweight tasks (latest Haiku)" },
    { id: "sonnet[1m]", note: "Sonnet with 1M extended context window" },
    { id: "opus[1m]", note: "Opus with 1M extended context window" },
    { id: "opusplan", note: "Opus for planning, Sonnet for execution" },
    { id: "best", note: "Highest-tier reasoning model on your account" },
  ],
  codex: [
    { id: "gpt-5.6-sol", note: "GPT-5.6 Sol flagship reasoning & coding" },
    { id: "gpt-5.3-codex", note: "Codex agentic coding model" },
    { id: "gpt-5.2-codex", note: "GPT-5.2 Codex" },
    { id: "gpt-5.1-codex", note: "GPT-5.1 Codex" },
    { id: "o3", note: "OpenAI o3 reasoning model" },
    { id: "o4-mini", note: "Fast o4-mini reasoning model" },
  ],
  agy: [
    { id: "gemini-2.5-pro", note: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", note: "Fast Gemini 2.5 Flash" },
    { id: "claude-sonnet-4-5", note: "Claude Sonnet via Antigravity" },
    { id: "claude-opus-4-5", note: "Claude Opus via Antigravity" },
  ],
  deepseek: [
    { id: "deepseek-chat", note: "DeepSeek V3 chat & coding (fast)" },
    { id: "deepseek-reasoner", note: "DeepSeek R1 reasoning with thinking stream" },
  ],
  kimi: [
    { id: "kimi-for-coding", note: "Kimi Code default coding model" },
    { id: "kimi-k2.5", note: "Kimi K2.5 flagship" },
    { id: "kimi-k2-thinking", note: "Kimi K2 deep reasoning" },
    { id: "kimi-k2-turbo-preview", note: "Kimi K2 high-speed turbo" },
  ],
};

const MODEL_ALIASES: Record<AgentId, Record<string, string>> = {
  claude: {
    s: "sonnet",
    o: "opus",
    h: "haiku",
  },
  codex: {
    "5.3": "gpt-5.3-codex",
    "5.2": "gpt-5.2-codex",
    "5.1": "gpt-5.1-codex",
  },
  agy: {},
  deepseek: {
    chat: "deepseek-chat",
    v3: "deepseek-chat",
    reasoner: "deepseek-reasoner",
    r1: "deepseek-reasoner",
  },
  kimi: {
    k2: "kimi-k2.5",
    thinking: "kimi-k2-thinking",
    turbo: "kimi-k2-turbo-preview",
  },
};

export function resolveModelAlias(agent: AgentId, raw: string): string {
  const trimmed = raw.trim();
  const alias = MODEL_ALIASES[agent]?.[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

function safeReadText(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function safeReadJson(filePath: string): unknown {
  const raw = safeReadText(filePath);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function discoverClaudeLocalModels(): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const json = safeReadJson(settingsPath);
  if (json && typeof json === "object") {
    const rec = json as Record<string, unknown>;
    if (typeof rec.model === "string" && rec.model.trim()) {
      out.push({ id: rec.model.trim(), note: "Configured in ~/.claude/settings.json" });
    }
    if (Array.isArray(rec.availableModels)) {
      for (const m of rec.availableModels) {
        if (typeof m === "string" && m.trim()) {
          out.push({ id: m.trim(), note: "From ~/.claude/settings.json" });
        }
      }
    }
  }
  return out;
}

export function parseCodexModelsCache(data: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? (data as Record<string, unknown>).models ?? (data as Record<string, unknown>).data
      : undefined;

  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim(), note: "From Codex models_cache.json" });
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const id =
        (typeof rec.slug === "string" && rec.slug) ||
        (typeof rec.id === "string" && rec.id) ||
        (typeof rec.model === "string" && rec.model) ||
        (typeof rec.name === "string" && rec.name);
      if (id && id.trim()) {
        const desc =
          (typeof rec.display_name === "string" && rec.display_name !== id ? rec.display_name : undefined) ??
          (typeof rec.description === "string" ? rec.description.slice(0, 64) : undefined);
        out.push({
          id: id.trim(),
          note: desc ? `${desc} (Codex cache)` : "From ~/.codex/models_cache.json",
        });
      }
    }
  }
  return out;
}

function discoverCodexLocalModels(): DiscoveredModel[] {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const out: DiscoveredModel[] = [];

  const toml = safeReadText(path.join(codexHome, "config.toml"));
  if (toml) {
    for (const match of toml.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) {
      if (match[1]) {
        out.push({ id: match[1], note: "Configured in ~/.codex/config.toml" });
      }
    }
  }

  const cacheJson = safeReadJson(path.join(codexHome, "models_cache.json"));
  if (cacheJson) {
    out.push(...parseCodexModelsCache(cacheJson));
  }

  return out;
}

export function parseKimiTomlModels(toml: string, sourceLabel: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const match of toml.matchAll(/^\s*default_model\s*=\s*["']([^"']+)["']/gm)) {
    if (match[1]) {
      out.push({ id: match[1], note: `Default in ${sourceLabel}` });
    }
  }

  // Parse [models."..."] sections including optional display_name field
  let currentKey: string | undefined;
  let currentDisplay: string | undefined;

  const flush = (): void => {
    if (currentKey) {
      out.push({
        id: currentKey,
        note: currentDisplay ? `${currentDisplay} (${sourceLabel})` : `From ${sourceLabel}`,
      });
    }
    currentKey = undefined;
    currentDisplay = undefined;
  };

  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      flush();
      const modHeader = header[1].match(/^models\.(.+)$/);
      if (modHeader) {
        currentKey = modHeader[1].replace(/^["']|["']$/g, "").trim();
      }
      continue;
    }
    if (currentKey) {
      const disp = line.match(/^display_name\s*=\s*["']([^"']+)["']/);
      if (disp?.[1]) {
        currentDisplay = disp[1];
      }
    }
  }
  flush();

  return out;
}

function discoverKimiLocalModels(): DiscoveredModel[] {
  const home = os.homedir();
  const out: DiscoveredModel[] = [];
  const paths: Array<[string, string]> = [
    [path.join(home, ".kimi", "config.toml"), "~/.kimi/config.toml"],
    [path.join(home, ".kimi-code", "config.toml"), "~/.kimi-code/config.toml"],
  ];
  for (const [full, label] of paths) {
    const toml = safeReadText(full);
    if (toml) {
      out.push(...parseKimiTomlModels(toml, label));
    }
  }
  return out;
}

export function parseCliModelsOutput(stdout: string, sourceLabel: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("Usage") ||
      line.startsWith("Available") ||
      line.startsWith("Error") ||
      line.startsWith("ERROR") ||
      line.startsWith("─") ||
      line.startsWith("-") && !line.startsWith("- ")
    ) {
      continue;
    }
    const cleaned = line.replace(/^[*•▸●○\-]\s+/, "").trim();
    const match = cleaned.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{2,})(?:\s+(?:[-–—:]\s*)?(.+))?$/);
    if (match) {
      const id = match[1];
      const extra = match[2]?.trim();
      out.push({
        id,
        note: extra ? `${extra.slice(0, 64)} (${sourceLabel})` : `From ${sourceLabel}`,
      });
    }
  }
  return out;
}

async function runModelsSubcommand(
  binary: string,
  args: string[],
  sourceLabel: string,
): Promise<DiscoveredModel[]> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 3000,
      maxBuffer: 512 * 1024,
    });
    return parseCliModelsOutput(stdout || "", sourceLabel);
  } catch {
    return [];
  }
}

async function discoverAgyModelsAsync(agentConfig: AgentConfig): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = [];

  // 1. Check ~/.gemini/antigravity-cli/settings.json
  const settings = safeReadJson(path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"));
  if (settings && typeof settings === "object") {
    const rec = settings as Record<string, unknown>;
    if (typeof rec.model === "string" && rec.model.trim()) {
      out.push({ id: rec.model.trim(), note: "Configured in agy settings.json" });
    }
  }

  // 2. Run `agy models` live
  const bin = resolveBinary(agentConfig.command ? [agentConfig.command] : ["agy"]);
  if (bin) {
    const live = await runModelsSubcommand(bin, ["models"], "agy models");
    out.push(...live);
  }

  return out;
}

async function discoverKimiModelsAsync(agentConfig: AgentConfig): Promise<DiscoveredModel[]> {
  const out = discoverKimiLocalModels();
  const bin = resolveBinary(agentConfig.command ? [agentConfig.command] : ["kimi"]);
  if (bin) {
    const live = await runModelsSubcommand(bin, ["models"], "kimi models");
    out.push(...live);
  }
  return out;
}

async function discoverDeepSeekModelsAsync(agentConfig: AgentConfig): Promise<DiscoveredModel[]> {
  const apiKey = agentConfig.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];

  const baseUrl = (agentConfig.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; context_window?: number }>;
    };
    if (!Array.isArray(body?.data)) return [];
    const out: DiscoveredModel[] = [];
    for (const item of body.data) {
      if (typeof item?.id === "string" && item.id.trim()) {
        const ctx =
          typeof item.context_window === "number"
            ? `, ${Math.round(item.context_window / 1000)}k ctx`
            : "";
        out.push({
          id: item.id.trim(),
          note: `Live from DeepSeek API${ctx}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const discoveryCache = new Map<AgentId, DiscoveredModel[]>();

function mergeModelOptions(
  agent: AgentId,
  agentConfig: AgentConfig,
  discovered: DiscoveredModel[],
): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];

  const push = (id: string, note: string | undefined, source: ModelOption["source"]): void => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    options.push({ id: trimmed, note, source });
  };

  if (agentConfig.model) {
    push(agentConfig.model, "Configured in ~/.mcli/config.json", "config");
  }
  if (Array.isArray(agentConfig.models)) {
    for (const m of agentConfig.models) {
      if (typeof m === "string") {
        push(m, "Custom model from ~/.mcli/config.json", "config");
      }
    }
  }

  for (const d of discovered) {
    push(d.id, d.note, "discovered");
  }

  for (const preset of DEFAULT_PRESETS[agent]) {
    push(preset.id, preset.note, "preset");
  }

  return options;
}

/**
 * Synchronous fast model lookup (uses local config files + cached live discovery + presets).
 */
export function getModelsForAgent(agent: AgentId, agentConfig: AgentConfig = {}): ModelOption[] {
  let discovered = discoveryCache.get(agent);
  if (!discovered) {
    if (agent === "claude") discovered = discoverClaudeLocalModels();
    else if (agent === "codex") discovered = discoverCodexLocalModels();
    else if (agent === "kimi") discovered = discoverKimiLocalModels();
    else discovered = [];
  }
  return mergeModelOptions(agent, agentConfig, discovered);
}

/**
 * Live async discovery across a single agent (CLI subcommands, local caches/configs, DeepSeek API).
 */
export async function discoverModelsForAgent(
  agent: AgentId,
  agentConfig: AgentConfig = {},
  forceRefresh = false,
): Promise<ModelOption[]> {
  if (!forceRefresh && discoveryCache.has(agent)) {
    return mergeModelOptions(agent, agentConfig, discoveryCache.get(agent) ?? []);
  }

  let discovered: DiscoveredModel[] = [];
  if (agent === "claude") {
    discovered = discoverClaudeLocalModels();
  } else if (agent === "codex") {
    discovered = discoverCodexLocalModels();
  } else if (agent === "agy") {
    discovered = await discoverAgyModelsAsync(agentConfig);
  } else if (agent === "deepseek") {
    discovered = await discoverDeepSeekModelsAsync(agentConfig);
  } else if (agent === "kimi") {
    discovered = await discoverKimiModelsAsync(agentConfig);
  }

  discoveryCache.set(agent, discovered);
  return mergeModelOptions(agent, agentConfig, discovered);
}

/**
 * Live async discovery across ALL 5 CLIs in parallel.
 */
export async function discoverAllAgentModels(
  config: McliConfig,
  opts?: { agents?: AgentId[]; forceRefresh?: boolean },
): Promise<Record<AgentId, ModelOption[]>> {
  const targets = opts?.agents && opts.agents.length > 0 ? opts.agents : [...AGENT_IDS];
  const entries = await Promise.all(
    targets.map(async (id) => [
      id,
      await discoverModelsForAgent(id, config.agents[id] ?? {}, opts?.forceRefresh),
    ] as const),
  );

  const out = {} as Record<AgentId, ModelOption[]>;
  for (const id of AGENT_IDS) {
    const found = entries.find(([k]) => k === id);
    out[id] = found ? found[1] : getModelsForAgent(id, config.agents[id] ?? {});
  }
  return out;
}
