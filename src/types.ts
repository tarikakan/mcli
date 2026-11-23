export const AGENT_IDS = ["claude", "codex", "agy", "deepseek", "kimi"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentMeta {
  id: AgentId;
  label: string;
  flag: string;
  color: "orange" | "green" | "cyan" | "magenta" | "yellow";
  description: string;
}

export const AGENT_META: Record<AgentId, AgentMeta> = {
  claude: {
    id: "claude",
    label: "Claude",
    flag: "--claude",
    color: "orange",
    description: "Anthropic Claude Code CLI",
  },
  codex: {
    id: "codex",
    label: "Codex",
    flag: "--codex",
    color: "green",
    description: "OpenAI Codex CLI",
  },
  agy: {
    id: "agy",
    label: "Agy",
    flag: "--agy",
    color: "cyan",
    description: "Google Antigravity CLI",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    flag: "--deepseek",
    color: "magenta",
    description: "DeepSeek CLI or Streaming API",
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    flag: "--kimi",
    color: "yellow",
    description: "Moonshot Kimi Code CLI",
  },
};

export interface AgentTarget {
  agent: AgentId;
  model?: string;
}

export function formatTargetLabel(target: AgentTarget): string {
  const base = AGENT_META[target.agent].label;
  return target.model ? `${base} (${target.model})` : base;
}

export function targetKey(target: AgentTarget): string {
  return `${target.agent}:${target.model ?? ""}`;
}

export interface AgentConfig {
  enabled?: boolean;
  command?: string;
  args?: string[];
  extraArgs?: string[];
  outputMode?: "stream-json" | "text";
  model?: string;
  /** Optional custom model list shown in the `/model` picker & `--models` */
  models?: string[];
  env?: Record<string, string>;
  /** DeepSeek / OpenAI-compatible API fallback settings */
  apiKey?: string;
  baseUrl?: string;
}

export type MemoryMode = "lean" | "balanced" | "full";

export interface MemoryConfig {
  /** Agent in charge of summarizing/compacting shared memory ("auto" picks cheapest available, "local" = 0 tokens) */
  agent: AgentId | "auto" | "local";
  /** Optional explicit model for the memory agent (defaults to fast/cheap tier like haiku / deepseek-chat / o4-mini) */
  model?: string;
  /** Automatically compact older turns in the background after turns cross threshold */
  autoCompact: boolean;
  /** Controls how much verbatim history is sent alongside the rolling summary */
  mode: MemoryMode;
  /** Unsummarized character threshold before auto-compaction triggers */
  autoCompactThresholdChars: number;
}

export interface McliConfig {
  defaultAgent: AgentId;
  shareContext: boolean;
  maxContextTurns: number;
  maxContextChars: number;
  agentDiscussion: boolean;
  discussionRounds: number;
  memory: MemoryConfig;
  agents: Record<AgentId, AgentConfig>;
}

export interface ToolEvent {
  name: string;
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  agent?: AgentId;
  model?: string;
  roundLabel?: string;
  content: string;
  reasoning?: string;
  tools?: ToolEvent[];
  timestamp: string;
  durationMs?: number;
  error?: string;
  aborted?: boolean;
}

export interface SessionData {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  activeAgent: AgentId;
  messages: ChatMessage[];
  agentSessions: Partial<Record<AgentId, string>>;
  /** Tier 1 rolling summary of older compacted conversation turns */
  summary?: string;
  /** Index into `messages` up to which turns have already been summarized */
  summarizedUpTo?: number;
}

export interface StreamEvent {
  type: "text" | "reasoning" | "tool" | "status" | "session" | "error" | "done";
  text?: string;
  toolName?: string;
  toolDetail?: string;
  sessionId?: string;
}

export interface AgentAvailability {
  id: AgentId;
  available: boolean;
  mode: "cli" | "api" | "missing";
  binaryPath?: string;
  detail: string;
}

export interface RunAgentOptions {
  prompt: string;
  rawUserPrompt: string;
  history: ChatMessage[];
  sessionSummary?: string;
  summarizedUpTo?: number;
  transcriptPath?: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  config: AgentConfig;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

export interface AgentRunResult {
  text: string;
  reasoning: string;
  tools: ToolEvent[];
  sessionId?: string;
  durationMs: number;
  error?: string;
  aborted?: boolean;
}

export interface AgentAdapter {
  id: AgentId;
  detect(config: AgentConfig): AgentAvailability;
  run(options: RunAgentOptions): Promise<AgentRunResult>;
}
