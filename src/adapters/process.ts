import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createStreamParserState, parseNdjsonLine } from "../stream-parser.ts";
import type { AgentRunResult, StreamEvent, ToolEvent } from "../types.ts";

export interface SpawnCliOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  outputMode: "stream-json" | "text";
  dialect: "claude" | "codex" | "agy" | "kimi" | "generic";
  stdinText?: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

function buildEnrichedEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPaths = [
    path.join(home, ".local", "bin"),
    path.join(home, ".kimi-code", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const currentPath = process.env.PATH || "";
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  for (const p of extraPaths) {
    if (!parts.includes(p)) parts.push(p);
  }
  return {
    ...process.env,
    PATH: parts.join(path.delimiter),
    ...extra,
  };
}

export function expandArgTemplate(template: string[], prompt: string): string[] {
  let replaced = false;
  const out = template.map((arg) => {
    if (arg.includes("{{prompt}}")) {
      replaced = true;
      return arg.replaceAll("{{prompt}}", prompt);
    }
    return arg;
  });
  if (!replaced) {
    out.push(prompt);
  }
  return out;
}

export async function runCliProcess(opts: SpawnCliOptions): Promise<AgentRunResult> {
  const start = Date.now();
  const state = createStreamParserState();
  const tools: ToolEvent[] = [];
  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let aborted = false;

  const emit = (ev: StreamEvent): void => {
    if (ev.type === "session" && ev.sessionId) {
      sessionId = ev.sessionId;
    } else if (ev.type === "tool" && ev.toolName) {
      tools.push({ name: ev.toolName, detail: ev.toolDetail });
    } else if (ev.type === "error" && ev.text) {
      errorMessage = ev.text;
    }
    opts.onEvent(ev);
  };

  return await new Promise<AgentRunResult>((resolve) => {
    let child;
    try {
      child = spawn(opts.binary, opts.args, {
        cwd: opts.cwd,
        env: buildEnrichedEnv(opts.env),
        stdio: [opts.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", text: `Failed to spawn ${opts.binary}: ${msg}` });
      resolve({
        text: "",
        reasoning: "",
        tools,
        durationMs: Date.now() - start,
        error: `Failed to spawn ${opts.binary}: ${msg}`,
      });
      return;
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let killTimer: NodeJS.Timeout | undefined;

    const handleAbort = (): void => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
    };

    if (opts.signal.aborted) {
      handleAbort();
    } else {
      opts.signal.addEventListener("abort", handleAbort, { once: true });
    }

    if (opts.stdinText !== undefined && child.stdin) {
      child.stdin.write(opts.stdinText);
      child.stdin.end();
    }

    const processLine = (line: string): void => {
      if (opts.outputMode === "text") {
        const chunk = line + "\n";
        state.emittedText += chunk;
        emit({ type: "text", text: chunk });
        return;
      }
      const events = parseNdjsonLine(line, state, opts.dialect);
      for (const ev of events) {
        emit(ev);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (opts.outputMode === "text") {
        state.emittedText += chunk;
        emit({ type: "text", text: chunk });
        return;
      }

      stdoutBuffer += chunk;
      let nlIndex = stdoutBuffer.indexOf("\n");
      while (nlIndex !== -1) {
        const line = stdoutBuffer.slice(0, nlIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(nlIndex + 1);
        processLine(line);
        nlIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 16000) {
        stderrBuffer = stderrBuffer.slice(-16000);
      }
    });

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener("abort", handleAbort);

      if (opts.outputMode === "stream-json" && stdoutBuffer.trim().length > 0) {
        processLine(stdoutBuffer.replace(/\r$/, ""));
        stdoutBuffer = "";
      }

      const trimmedStderr = stderrBuffer.trim();
      if (!aborted && code !== 0 && !errorMessage) {
        const reason = trimmedStderr
          ? trimmedStderr.split("\n").slice(-6).join("\n")
          : signal
            ? `Process terminated by signal ${signal}`
            : `Process exited with code ${code}`;
        errorMessage = reason;
        emit({ type: "error", text: reason });
      }

      emit({ type: "done" });

      resolve({
        text: state.emittedText.trimEnd(),
        reasoning: state.emittedReasoning.trimEnd(),
        tools,
        sessionId,
        durationMs: Date.now() - start,
        error: errorMessage,
        aborted,
      });
    };

    child.on("error", (err: Error) => {
      errorMessage = `Failed to run ${opts.binary}: ${err.message}`;
      emit({ type: "error", text: errorMessage });
      finalize(1, null);
    });

    child.on("close", (code, signal) => {
      finalize(code, signal);
    });
  });
}
