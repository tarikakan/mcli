import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_IDS } from "./types.ts";
import type { AgentConfig, AgentId, McliConfig } from "./types.ts";

export function getMcliHome(): string {
  return process.env.MCLI_HOME || path.join(os.homedir(), ".mcli");
}

export function getConfigPath(): string {
  return path.join(getMcliHome(), "config.json");
}

export function getSessionsDir(): string {
  return path.join(getMcliHome(), "sessions");
}

export function createDefaultConfig(): McliConfig {
  return {
    defaultAgent: "claude",
    shareContext: true,
    maxContextTurns: 12,
    maxContextChars: 24000,
    agentDiscussion: false,
    discussionRounds: 2,
    memory: {
      agent: "auto",
      autoCompact: true,
      mode: "balanced",
      autoCompactThresholdChars: 6000,
    },
    agents: {
      claude: {
        enabled: true,
        outputMode: "stream-json",
        extraArgs: [],
      },
      codex: {
        enabled: true,
        outputMode: "stream-json",
        extraArgs: [],
      },
      agy: {
        enabled: true,
        outputMode: "stream-json",
        extraArgs: [],
      },
      deepseek: {
        enabled: true,
        outputMode: "text",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        extraArgs: [],
      },
      kimi: {
        enabled: true,
        outputMode: "stream-json",
        extraArgs: [],
      },
    },
  };
}

export function loadConfig(): McliConfig {
  const defaults = createDefaultConfig();
  const configPath = getConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      return defaults;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<McliConfig>;
    const mergedAgents = { ...defaults.agents };

    if (parsed.agents && typeof parsed.agents === "object") {
      for (const id of AGENT_IDS) {
        const override = parsed.agents[id];
        if (override && typeof override === "object") {
          mergedAgents[id] = {
            ...defaults.agents[id],
            ...override,
          };
        }
      }
    }

    return {
      defaultAgent:
        parsed.defaultAgent && AGENT_IDS.includes(parsed.defaultAgent)
          ? parsed.defaultAgent
          : defaults.defaultAgent,
      shareContext:
        typeof parsed.shareContext === "boolean" ? parsed.shareContext : defaults.shareContext,
      maxContextTurns:
        typeof parsed.maxContextTurns === "number" && parsed.maxContextTurns > 0
          ? parsed.maxContextTurns
          : defaults.maxContextTurns,
      maxContextChars:
        typeof parsed.maxContextChars === "number" && parsed.maxContextChars > 0
          ? parsed.maxContextChars
          : defaults.maxContextChars,
      agentDiscussion:
        typeof parsed.agentDiscussion === "boolean"
          ? parsed.agentDiscussion
          : defaults.agentDiscussion,
      discussionRounds:
        typeof parsed.discussionRounds === "number" && parsed.discussionRounds >= 1
          ? Math.min(6, Math.floor(parsed.discussionRounds))
          : defaults.discussionRounds,
      memory: {
        agent:
          parsed.memory?.agent === "auto" ||
          parsed.memory?.agent === "local" ||
          (parsed.memory?.agent && AGENT_IDS.includes(parsed.memory.agent))
            ? parsed.memory.agent
            : defaults.memory.agent,
        model: typeof parsed.memory?.model === "string" ? parsed.memory.model : defaults.memory.model,
        autoCompact:
          typeof parsed.memory?.autoCompact === "boolean"
            ? parsed.memory.autoCompact
            : defaults.memory.autoCompact,
        mode:
          parsed.memory?.mode === "lean" ||
          parsed.memory?.mode === "balanced" ||
          parsed.memory?.mode === "full"
            ? parsed.memory.mode
            : defaults.memory.mode,
        autoCompactThresholdChars:
          typeof parsed.memory?.autoCompactThresholdChars === "number" &&
          parsed.memory.autoCompactThresholdChars >= 1000
            ? parsed.memory.autoCompactThresholdChars
            : defaults.memory.autoCompactThresholdChars,
      },
      agents: mergedAgents,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: McliConfig): string {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

function getExtraBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".kimi-code", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a binary name or explicit path by searching PATH plus common user bin dirs.
 * Also handles symlinks whose target may live in user-local directories.
 */
export function resolveBinary(candidates: string[]): string | undefined {
  const pathEnv = process.env.PATH || "";
  const searchDirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...getExtraBinDirs(),
  ];
  const seenDirs = new Set<string>();
  const uniqueDirs = searchDirs.filter((d) => {
    if (seenDirs.has(d)) return false;
    seenDirs.add(d);
    return true;
  });

  for (const candidate of candidates) {
    if (!candidate) continue;

    // Explicit path (absolute or relative with separator)
    if (candidate.includes(path.sep) || candidate.startsWith(".")) {
      const expanded = candidate.startsWith("~")
        ? path.join(os.homedir(), candidate.slice(1))
        : path.resolve(candidate);
      if (isExecutableFile(expanded)) {
        return expanded;
      }
      continue;
    }

    for (const dir of uniqueDirs) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full)) {
        return full;
      }
    }
  }

  return undefined;
}

export function getAgentConfig(config: McliConfig, agent: AgentId): AgentConfig {
  return config.agents[agent] ?? {};
}
