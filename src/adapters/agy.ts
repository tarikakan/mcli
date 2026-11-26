import { resolveBinary } from "../config.ts";
import { filterExistingDirs } from "../permissions.ts";
import type { AgentAdapter, AgentAvailability, AgentConfig, AgentRunResult, RunAgentOptions } from "../types.ts";
import { expandArgTemplate, runCliProcess } from "./process.ts";

function findBinary(config: AgentConfig): string | undefined {
  const candidates = config.command ? [config.command] : ["agy"];
  return resolveBinary(candidates);
}

export const agyAdapter: AgentAdapter = {
  id: "agy",

  detect(config: AgentConfig): AgentAvailability {
    if (config.enabled === false) {
      return { id: "agy", available: false, mode: "missing", detail: "Disabled in config" };
    }
    const bin = findBinary(config);
    if (!bin) {
      return {
        id: "agy",
        available: false,
        mode: "missing",
        detail: "CLI not found (install Antigravity CLI `agy` or set agents.agy.command)",
      };
    }
    return { id: "agy", available: true, mode: "cli", binaryPath: bin, detail: bin };
  },

  async run(opts: RunAgentOptions): Promise<AgentRunResult> {
    const bin = findBinary(opts.config);
    if (!bin) {
      const error =
        "Agy CLI not found on PATH. Install Antigravity CLI (`agy`) or set `agents.agy.command` in ~/.mcli/config.json.";
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
      args = ["--print"];
      if (outputMode === "stream-json") {
        args.push("--output-format", "stream-json");
      } else {
        args.push("--output-format", "text");
      }
      if (model) {
        args.push("--model", model);
      }
      const extra = opts.config.extraArgs ?? [];
      const hasPermFlag = extra.some(
        (a) => a === "--mode" || a.startsWith("--mode=") || a === "--dangerously-skip-permissions",
      );
      if (!hasPermFlag && opts.permissionMode) {
        if (opts.permissionMode === "read-only") {
          args.push("--mode", "plan");
        } else if (opts.permissionMode === "edit") {
          args.push("--mode", "accept-edits");
        } else if (opts.permissionMode === "full") {
          args.push("--dangerously-skip-permissions");
        }
      }
      if (opts.allowedDirs?.length) {
        for (const dir of filterExistingDirs(opts.allowedDirs, opts.cwd)) {
          args.push("--add-dir", dir);
        }
      }
      if (extra.length) {
        args.push(...extra);
      }
      args.push(opts.prompt);
    }

    return runCliProcess({
      binary: bin,
      args,
      cwd: opts.cwd,
      env: opts.config.env,
      outputMode,
      dialect: "agy",
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
  },
};
