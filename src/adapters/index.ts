import { AGENT_IDS } from "../types.ts";
import type { AgentAdapter, AgentAvailability, AgentId, McliConfig } from "../types.ts";
import { agyAdapter } from "./agy.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { kimiAdapter } from "./kimi.ts";

export const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  deepseek: deepseekAdapter,
  kimi: kimiAdapter,
};

export function getAdapter(agent: AgentId): AgentAdapter {
  return ADAPTERS[agent];
}

export function detectAllAgents(config: McliConfig): Record<AgentId, AgentAvailability> {
  const result = {} as Record<AgentId, AgentAvailability>;
  for (const id of AGENT_IDS) {
    result[id] = ADAPTERS[id].detect(config.agents[id] ?? {});
  }
  return result;
}

export function pickInitialAgent(
  config: McliConfig,
  availability: Record<AgentId, AgentAvailability>,
  requested?: AgentId,
): AgentId {
  if (requested) return requested;
  if (availability[config.defaultAgent]?.available) {
    return config.defaultAgent;
  }
  for (const id of AGENT_IDS) {
    if (availability[id]?.available) {
      return id;
    }
  }
  return config.defaultAgent;
}
