import { AGENT_IDS } from "./types.ts";
import type { AgentId } from "./types.ts";

export interface ParsedCliArgs {
  agents: AgentId[];
  promptParts: string[];
  prompt: string;
  model?: string;
  session?: string;
  newSession: boolean;
  noContext: boolean;
  plain: boolean;
  status: boolean;
  initConfig: boolean;
  help: boolean;
  version: boolean;
  passthroughArgs: string[];
  unknownFlags: string[];
}

export interface ParsedInlineInput {
  agents: AgentId[];
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

export function flagToAgent(token: string): AgentId | undefined {
  if (token.startsWith("--")) {
    const name = token.slice(2).toLowerCase();
    if (isAgentId(name)) return name;
  }
  if (token.startsWith("@")) {
    const name = token.slice(1).toLowerCase();
    if (isAgentId(name)) return name;
  }
  return undefined;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    agents: [],
    promptParts: [],
    prompt: "",
    newSession: false,
    noContext: false,
    plain: false,
    status: false,
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

    const agent = flagToAgent(arg);
    if (agent) {
      if (!result.agents.includes(agent)) {
        result.agents.push(agent);
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
 * Parses an interactive chat message, supporting leading agent flags such as:
 *   "--codex fix the tests"
 *   "--claude --deepseek compare these two designs"
 *   "--agy" (switches active agent without sending a prompt)
 *   "@kimi explain this module"
 *   "/help" (slash command)
 */
export function parseInlineInput(raw: string): ParsedInlineInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      agents: [],
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
      prompt: "",
      switchOnly: false,
      isSlashCommand: true,
      command,
      commandArgs,
    };
  }

  const agents: AgentId[] = [];
  let cursor = trimmed;

  while (cursor.length > 0) {
    const match = cursor.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) break;
    const token = match[1];
    const rest = (match[2] ?? "").trim();
    const agent = flagToAgent(token);
    if (!agent) break;
    if (!agents.includes(agent)) {
      agents.push(agent);
    }
    cursor = rest;
  }

  return {
    agents,
    prompt: cursor,
    switchOnly: agents.length > 0 && cursor.length === 0,
    isSlashCommand: false,
  };
}
