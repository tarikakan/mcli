import { resolveBinary } from "../config.ts";
import type { AgentAdapter, AgentAvailability, AgentConfig, AgentRunResult, RunAgentOptions } from "../types.ts";
import { expandArgTemplate, runCliProcess } from "./process.ts";

function findBinary(config: AgentConfig): string | undefined {
  const candidates = config.command ? [config.command] : ["codex"];
  return resolveBinary(candidates);
}

export const codexAdapter: AgentAdapter = {
  id: "codex",

  detect(config: AgentConfig): AgentAvailability {
    if (config.enabled === false) {
      return { id: "codex", available: false, mode: "missing", detail: "Disabled in config" };
    }
    const bin = findBinary(config);
    if (!bin) {
      return {
        id: "codex",
        available: false,
        mode: "missing",
        detail: "CLI not found (install @openai/codex or set agents.codex.command)",
      };
    }
    return { id: "codex", available: true, mode: "cli", binaryPath: bin, detail: bin };
  },

  async run(opts: RunAgentOptions): Promise<AgentRunResult> {
    const bin = findBinary(opts.config);
    if (!bin) {
      const error =
        "Codex CLI not found on PATH. Install OpenAI Codex CLI (`codex`) or set `agents.codex.command` in ~/.mcli/config.json.";
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
      args = ["exec"];
      const hasSkipCheck = opts.config.extraArgs?.includes("--skip-git-repo-check");
      if (!hasSkipCheck) {
        args.push("--skip-git-repo-check");
      }
      if (outputMode === "stream-json") {
        args.push("--json");
      }
      if (model) {
        args.push("--model", model);
      }
      const extra = opts.config.extraArgs ?? [];
      const hasPermFlag = extra.some(
        (a) =>
          a === "--sandbox" ||
          a.startsWith("--sandbox=") ||
          a === "-s" ||
          a === "--full-auto" ||
          a === "--yolo" ||
          a === "--dangerously-bypass-approvals-and-sandbox",
      );
      if (!hasPermFlag && opts.permissionMode) {
        if (opts.permissionMode === "read-only") {
          args.push("--sandbox", "read-only");
        } else if (opts.permissionMode === "edit") {
          args.push("--sandbox", "workspace-write");
        } else if (opts.permissionMode === "full") {
          args.push("--dangerously-bypass-approvals-and-sandbox");
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
      dialect: "codex",
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
  },
};
