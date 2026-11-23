import path from "node:path";
import { resolveBinary } from "../config.ts";
import { parseOpenAiSseLine } from "../stream-parser.ts";
import { AGENT_META } from "../types.ts";
import type {
  AgentAdapter,
  AgentAvailability,
  AgentConfig,
  AgentRunResult,
  ChatMessage,
  RunAgentOptions,
} from "../types.ts";
import { expandArgTemplate, runCliProcess } from "./process.ts";

function findBinary(config: AgentConfig): string | undefined {
  const candidates = config.command ? [config.command] : ["deepseek", "dsh"];
  return resolveBinary(candidates);
}

function getApiKey(config: AgentConfig): string | undefined {
  return config.apiKey || process.env.DEEPSEEK_API_KEY;
}

function buildApiMessages(
  history: ChatMessage[],
  rawUserPrompt: string,
  cwd: string,
  sessionSummary?: string,
  summarizedUpTo?: number,
  skillsPromptBlock?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const systemParts = [
    `You are DeepSeek participating in a unified multi-agent terminal chat (mcli). Current working directory: ${cwd}. Be concise, accurate, and directly continue from any prior turns in the shared conversation.`,
  ];
  if (skillsPromptBlock && skillsPromptBlock.trim()) {
    systemParts.push(`\n${skillsPromptBlock.trim()}`);
  }
  if (sessionSummary && sessionSummary.trim()) {
    systemParts.push(`\nEarlier conversation summary:\n${sessionSummary.trim()}`);
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: systemParts.join("\n"),
    },
  ];

  const start = Math.max(0, Math.min(summarizedUpTo ?? 0, history.length));
  const recent = history.slice(start).slice(-24);

  for (const msg of recent) {
    if (msg.role === "user" && msg.content.trim()) {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant" && msg.content.trim()) {
      const label = msg.agent ? AGENT_META[msg.agent].label : "Agent";
      const mod = msg.model ? `/${msg.model}` : "";
      const round = msg.roundLabel ? ` · ${msg.roundLabel}` : "";
      const prefix =
        msg.agent && (msg.agent !== "deepseek" || msg.roundLabel)
          ? `[${label}${mod}${round}]: `
          : "";
      messages.push({ role: "assistant", content: prefix + msg.content });
    }
  }

  messages.push({ role: "user", content: rawUserPrompt });
  return messages;
}

async function runDeepSeekApi(opts: RunAgentOptions, apiKey: string): Promise<AgentRunResult> {
  const start = Date.now();
  const baseUrl = (opts.config.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;
  const model = opts.model || opts.config.model || "deepseek-chat";

  let text = "";
  let reasoning = "";
  let error: string | undefined;
  let aborted = false;

  const messages = buildApiMessages(
    opts.history,
    opts.rawUserPrompt,
    opts.cwd,
    opts.sessionSummary,
    opts.summarizedUpTo,
    opts.skillsPromptBlock,
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      error = `DeepSeek API HTTP ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`;
      opts.onEvent({ type: "error", text: error });
      opts.onEvent({ type: "done" });
      return { text, reasoning, tools: [], durationMs: Date.now() - start, error };
    }

    if (!response.body) {
      error = "DeepSeek API returned an empty response body.";
      opts.onEvent({ type: "error", text: error });
      opts.onEvent({ type: "done" });
      return { text, reasoning, tools: [], durationMs: Date.now() - start, error };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const events = parseOpenAiSseLine(line);
        for (const ev of events) {
          if (ev.type === "text" && ev.text) {
            text += ev.text;
            opts.onEvent(ev);
          } else if (ev.type === "reasoning" && ev.text) {
            reasoning += ev.text;
            opts.onEvent(ev);
          } else if (ev.type === "error" && ev.text) {
            error = ev.text;
            opts.onEvent(ev);
          }
        }
        nl = buffer.indexOf("\n");
      }
    }

    if (buffer.trim()) {
      for (const ev of parseOpenAiSseLine(buffer)) {
        if (ev.type === "text" && ev.text) {
          text += ev.text;
          opts.onEvent(ev);
        } else if (ev.type === "reasoning" && ev.text) {
          reasoning += ev.text;
          opts.onEvent(ev);
        } else if (ev.type === "error" && ev.text) {
          error = ev.text;
          opts.onEvent(ev);
        }
      }
    }
  } catch (err) {
    if (opts.signal.aborted) {
      aborted = true;
    } else {
      error = `DeepSeek API request failed: ${err instanceof Error ? err.message : String(err)}`;
      opts.onEvent({ type: "error", text: error });
    }
  }

  opts.onEvent({ type: "done" });

  return {
    text: text.trimEnd(),
    reasoning: reasoning.trimEnd(),
    tools: [],
    durationMs: Date.now() - start,
    error,
    aborted,
  };
}

export const deepseekAdapter: AgentAdapter = {
  id: "deepseek",

  detect(config: AgentConfig): AgentAvailability {
    if (config.enabled === false) {
      return { id: "deepseek", available: false, mode: "missing", detail: "Disabled in config" };
    }
    const bin = findBinary(config);
    if (bin) {
      return { id: "deepseek", available: true, mode: "cli", binaryPath: bin, detail: bin };
    }
    const apiKey = getApiKey(config);
    if (apiKey) {
      const model = config.model || "deepseek-chat";
      return {
        id: "deepseek",
        available: true,
        mode: "api",
        detail: `API fallback (${model} via ${config.baseUrl || "https://api.deepseek.com"})`,
      };
    }
    return {
      id: "deepseek",
      available: false,
      mode: "missing",
      detail: "No deepseek/dsh CLI found & DEEPSEEK_API_KEY not set",
    };
  },

  async run(opts: RunAgentOptions): Promise<AgentRunResult> {
    const bin = findBinary(opts.config);
    if (bin) {
      const outputMode = opts.config.outputMode ?? "text";
      const model = opts.model ?? opts.config.model;
      let args: string[];

      if (opts.config.args && opts.config.args.length > 0) {
        args = expandArgTemplate(opts.config.args, opts.prompt);
      } else if (path.basename(bin) === "dsh") {
        args = ["--profile", "headless", ...(opts.config.extraArgs ?? []), opts.prompt];
      } else {
        args = [];
        if (model) {
          args.push("--model", model);
        }
        if (opts.config.extraArgs?.length) {
          args.push(...opts.config.extraArgs);
        }
        args.push(opts.prompt);
      }

      return runCliProcess({
        binary: bin,
        args,
        cwd: opts.cwd,
        env: opts.config.env,
        outputMode,
        dialect: "generic",
        signal: opts.signal,
        onEvent: opts.onEvent,
      });
    }

    const apiKey = getApiKey(opts.config);
    if (apiKey) {
      return runDeepSeekApi(opts, apiKey);
    }

    const error = [
      "DeepSeek is not configured yet.",
      "Either:",
      "  1. Export DEEPSEEK_API_KEY=sk-... (uses built-in streaming API), or",
      "  2. Install a DeepSeek CLI (`deepseek` or `dsh`), or",
      "  3. Set `agents.deepseek.apiKey` or `agents.deepseek.command` in ~/.mcli/config.json.",
    ].join("\n");

    opts.onEvent({ type: "error", text: error });
    opts.onEvent({ type: "done" });
    return { text: "", reasoning: "", tools: [], durationMs: 0, error };
  },
};
