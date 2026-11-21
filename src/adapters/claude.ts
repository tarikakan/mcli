import { resolveBinary } from "../config.ts";
import type { AgentAdapter, AgentAvailability, AgentConfig, AgentRunResult, RunAgentOptions } from "../types.ts";
import { expandArgTemplate, runCliProcess } from "./process.ts";

function findBinary(config: AgentConfig): string | undefined {
  const candidates = config.command ? [config.command] : ["claude"];
  return resolveBinary(candidates);
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",

  detect(config: AgentConfig): AgentAvailability {
    if (config.enabled === false) {
      return { id: "claude", available: false, mode: "missing", detail: "Disabled in config" };
    }
    const bin = findBinary(config);
    if (!bin) {
      return {
        id: "claude",
        available: false,
        mode: "missing",
        detail: "CLI not found (install Claude Code or set agents.claude.command)",
      };
    }
    return { id: "claude", available: true, mode: "cli", binaryPath: bin, detail: bin };
  },

  async run(opts: RunAgentOptions): Promise<AgentRunResult> {
    const bin = findBinary(opts.config);
    if (!bin) {
      const error =
        "Claude CLI not found on PATH. Install Claude Code (`claude`) or set `agents.claude.command` in ~/.mcli/config.json.";
      opts.onEvent({ type: "error", text: error });
      opts.onEvent({ type: "done" });
      return { text: "", reasoning: "", tools: [], durationMs: 0, error };
    }

    const outputMode = opts.config.outputMode ?? "stream-json";
    const model = opts.model ?? opts.config.model;
    let args: string[];

    if (opts.config.args && opts.config.args.length > 0) {
      args = expandArgTemplate(opts.config.args, opts.prompt);
    } else {
      args = ["-p", opts.prompt];
      if (outputMode === "stream-json") {
        args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
      } else {
        args.push("--output-format", "text");
      }
      if (model) {
        args.push("--model", model);
      }
      if (opts.config.extraArgs?.length) {
        args.push(...opts.config.extraArgs);
      }
    }

    return runCliProcess({
      binary: bin,
      args,
      cwd: opts.cwd,
      env: opts.config.env,
      outputMode,
      dialect: "claude",
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
  },
};
