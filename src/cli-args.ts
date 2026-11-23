import { resolveModelAlias } from "./models.ts";
import { AGENT_IDS } from "./types.ts";
import type { AgentId } from "./types.ts";

export interface ParsedCliArgs {
  agents: AgentId[];
  agentModels: Partial<Record<AgentId, string>>;
  promptParts: string[];
  prompt: string;
  model?: string;
  session?: string;
  newSession: boolean;
  noContext: boolean;
  plain: boolean;
  status: boolean;
  listModels: boolean;
  initConfig: boolean;
  help: boolean;
  version: boolean;
  passthroughArgs: string[];
  unknownFlags: string[];
}

export interface ParsedInlineInput {
  agents: AgentId[];
  agentModels: Partial<Record<AgentId, string>>;
  modelOverride?: string;
  listModels: boolean;
  prompt: string;
  switchOnly: boolean;
  isSlashCommand: boolean;
  command?: string;
  commandArgs?: string;
}

const AGENT_SET = new Set<string>(AGENT_IDS);

export function isAgentId(value: string): value is AgentId {
  return AGENT_SET.has(value);
}

export function parseAgentToken(token: string): { agent: AgentId; model?: string } | undefined {
  let body: string | undefined;
  if (token.startsWith("--")) {
    body = token.slice(2);
  } else if (token.startsWith("@")) {
    body = token.slice(1);
  }
  if (!body) return undefined;

  const colonIdx = body.indexOf(":");
  if (colonIdx !== -1) {
    const name = body.slice(0, colonIdx).toLowerCase();
    const rawModel = body.slice(colonIdx + 1).trim();
    if (isAgentId(name) && rawModel.length > 0) {
      return { agent: name, model: resolveModelAlias(name, rawModel) };
    }
    return undefined;
  }

  const name = body.toLowerCase();
  if (isAgentId(name)) {
    return { agent: name };
  }
  return undefined;
}

export function flagToAgent(token: string): AgentId | undefined {
  return parseAgentToken(token)?.agent;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    agents: [],
    agentModels: {},
    promptParts: [],
    prompt: "",
    newSession: false,
    noContext: false,
    plain: false,
    status: false,
    listModels: false,
    initConfig: false,
    help: false,
    version: false,
    passthroughArgs: [],
    unknownFlags: [],
  };

  let inPassthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (inPassthrough) {
      result.passthroughArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      inPassthrough = true;
      continue;
    }

    const parsedAgent = parseAgentToken(arg);
    if (parsedAgent) {
      if (!result.agents.includes(parsedAgent.agent)) {
        result.agents.push(parsedAgent.agent);
      }
      if (parsedAgent.model) {
        result.agentModels[parsedAgent.agent] = parsedAgent.model;
      }
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      result.version = true;
      continue;
    }
    if (arg === "--status" || arg === "--doctor") {
      result.status = true;
      continue;
    }
    if (arg === "--models") {
      result.listModels = true;
      continue;
    }
    if (arg === "--init-config") {
      result.initConfig = true;
      continue;
    }
    if (arg === "--plain" || arg === "--no-tui") {
      result.plain = true;
      continue;
    }
    if (arg === "--new") {
      result.newSession = true;
      continue;
    }
    if (arg === "--no-context") {
      result.noContext = true;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const next = argv[i + 1];
      if (next !== undefined) {
        result.model = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      result.model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--session" || arg === "-s") {
      const next = argv[i + 1];
      if (next !== undefined) {
        result.session = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--session=")) {
      result.session = arg.slice("--session=".length);
      continue;
    }
    if (arg.startsWith("-") && result.promptParts.length === 0) {
      result.unknownFlags.push(arg);
      continue;
    }

    result.promptParts.push(arg);
  }

  result.prompt = result.promptParts.join(" ").trim();
  return result;
}

/**
 * Parses an interactive chat message, supporting leading agent/model flags:
 *   "--codex fix the tests"
 *   "--claude:opus review this architecture"
 *   "--claude --model sonnet explain this"
 *   "--claude:opus --deepseek:reasoner compare these two designs"
 *   "--agy" or "--claude:opus" (switches active agent / model without sending a prompt)
 *   "@kimi explain this module"
 *   "/model" or "/help" (slash command)
 */
export function parseInlineInput(raw: string): ParsedInlineInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      agents: [],
      agentModels: {},
      listModels: false,
      prompt: "",
      switchOnly: false,
      isSlashCommand: false,
    };
  }

  if (trimmed.startsWith("/")) {
    const spaceIdx = trimmed.search(/\s/);
    const command = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const commandArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
    return {
      agents: [],
      agentModels: {},
      listModels: false,
      prompt: "",
      switchOnly: false,
      isSlashCommand: true,
      command,
      commandArgs,
    };
  }

  const agents: AgentId[] = [];
  const agentModels: Partial<Record<AgentId, string>> = {};
  let modelOverride: string | undefined;
  let listModels = false;
  let cursor = trimmed;

  while (cursor.length > 0) {
    const match = cursor.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) break;
    const token = match[1];
    const rest = (match[2] ?? "").trim();

    if (token === "--models") {
      listModels = true;
      cursor = rest;
      continue;
    }

    if (token === "--model" || token === "-m") {
      const nextMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (!nextMatch) break;
      modelOverride = nextMatch[1];
      cursor = (nextMatch[2] ?? "").trim();
      continue;
    }
    if (token.startsWith("--model=")) {
      modelOverride = token.slice("--model=".length);
      cursor = rest;
      continue;
    }

    const parsedAgent = parseAgentToken(token);
    if (!parsedAgent) break;
    if (!agents.includes(parsedAgent.agent)) {
      agents.push(parsedAgent.agent);
    }
    if (parsedAgent.model) {
      agentModels[parsedAgent.agent] = parsedAgent.model;
    }
    cursor = rest;
  }

  return {
    agents,
    agentModels,
    modelOverride,
    listModels,
    prompt: cursor,
    switchOnly: !listModels && (agents.length > 0 || Boolean(modelOverride)) && cursor.length === 0,
    isSlashCommand: false,
  };
}
