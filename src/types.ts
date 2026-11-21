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

export interface AgentConfig {
  enabled?: boolean;
  command?: string;
  args?: string[];
  extraArgs?: string[];
  outputMode?: "stream-json" | "text";
  model?: string;
  env?: Record<string, string>;
  /** DeepSeek / OpenAI-compatible API fallback settings */
  apiKey?: string;
  baseUrl?: string;
}

export interface McliConfig {
  defaultAgent: AgentId;
  shareContext: boolean;
  maxContextTurns: number;
  maxContextChars: number;
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
