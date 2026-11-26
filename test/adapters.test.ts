import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { getAdapter } from "../src/adapters/index.ts";

function createMockBin(dir: string, name: string, scriptBody: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
  return filePath;
}

describe("adapters end-to-end", () => {
  it("runs mock claude, codex, agy, and kimi CLIs and streams parsed events", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-bins-"));
    try {
      const mockClaude = createMockBin(
        tmpDir,
        "claude",
        `
        console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude says hi" } } }));
        console.log(JSON.stringify({ type: "result", session_id: "c-1", result: "Claude says hi" }));
        `,
      );
      const mockCodex = createMockBin(
        tmpDir,
        "codex",
        `
        console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "Codex args: " + process.argv.slice(2).join(" ") } }));
        `,
      );
      const mockAgy = createMockBin(
        tmpDir,
        "agy",
        `
        console.log(JSON.stringify({ type: "delta", text: "Agy ready" }));
        `,
      );
      const mockKimi = createMockBin(
        tmpDir,
        "kimi",
        `
        console.log(JSON.stringify({ type: "assistant", content: "Kimi reply" }));
        `,
      );

      const cases = [
        { id: "claude" as const, bin: mockClaude, expect: "Claude says hi" },
        { id: "codex" as const, bin: mockCodex, expect: "Codex args: exec --skip-git-repo-check --json hello" },
        { id: "agy" as const, bin: mockAgy, expect: "Agy ready" },
        { id: "kimi" as const, bin: mockKimi, expect: "Kimi reply" },
      ];

      for (const c of cases) {
        const adapter = getAdapter(c.id);
        const streamed: string[] = [];
        const controller = new AbortController();
        const res = await adapter.run({
          prompt: "hello",
          rawUserPrompt: "hello",
          history: [],
          cwd: tmpDir,
          config: { command: c.bin, outputMode: "stream-json" },
          signal: controller.signal,
          onEvent: (ev) => {
            if (ev.type === "text" && ev.text) streamed.push(ev.text);
          },
        });
        assert.equal(res.error, undefined);
        assert.equal(res.text, c.expect);
        assert.equal(streamed.join(""), c.expect);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("streams DeepSeek API fallback with shared history and reasoning_content", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody: Record<string, unknown> | undefined;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers.Authorization ?? "";
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"DeepSeek "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"works!"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const adapter = getAdapter("deepseek");
      const textChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const controller = new AbortController();

      const res = await adapter.run({
        prompt: "follow up",
        rawUserPrompt: "follow up",
        history: [
          { id: "1", role: "user", content: "initial", timestamp: "2026-01-01T00:00:00Z" },
          { id: "2", role: "assistant", agent: "claude", content: "from claude", timestamp: "2026-01-01T00:00:01Z" },
        ],
        cwd: process.cwd(),
        config: {
          command: "/nonexistent/deepseek-binary-for-test",
          apiKey: "test-key",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-reasoner",
        },
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === "text" && ev.text) textChunks.push(ev.text);
          if (ev.type === "reasoning" && ev.text) reasoningChunks.push(ev.text);
        },
      });

      assert.equal(res.error, undefined);
      assert.equal(res.text, "DeepSeek works!");
      assert.equal(res.reasoning, "Thinking...");
      assert.equal(textChunks.join(""), "DeepSeek works!");
      assert.equal(reasoningChunks.join(""), "Thinking...");
      assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
      assert.equal(capturedAuth, "Bearer test-key");
      assert.equal(capturedBody?.model, "deepseek-reasoner");
      assert.equal(capturedBody?.stream, true);
      const msgs = capturedBody?.messages as Array<{ role: string; content: string }>;
      assert.ok(msgs.some((m) => m.role === "assistant" && m.content.includes("[Claude]: from claude")));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("carries shared history across agents via mcli CLI one-shot runs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-e2e-"));
    try {
      const mockClaude = createMockBin(
        tmpDir,
        "claude",
        `console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "CLAUDE_TOKEN_42" }] } }));`,
      );
      const mockCodex = createMockBin(
        tmpDir,
        "codex",
        `
        const prompt = process.argv[process.argv.length - 1];
        const hasClaudeCtx = prompt.includes("CLAUDE_TOKEN_42");
        console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "HAS_CONTEXT=" + hasClaudeCtx } }));
        `,
      );

      fs.writeFileSync(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          defaultAgent: "claude",
          shareContext: true,
          agents: {
            claude: { command: mockClaude, outputMode: "stream-json" },
            codex: { command: mockCodex, outputMode: "stream-json" },
          },
        }),
      );

      const env = { ...process.env, MCLI_HOME: tmpDir };
      const binPath = path.resolve(process.cwd(), "bin/mcli.mjs");

      const run1 = spawnSync(process.execPath, [binPath, "--claude", "--session", "handoff", "step 1"], {
        env,
        encoding: "utf8",
      });
      assert.equal(run1.status, 0, run1.stderr);
      assert.match(run1.stdout, /CLAUDE_TOKEN_42/);

      const run2 = spawnSync(process.execPath, [binPath, "--codex", "--session", "handoff", "step 2"], {
        env,
        encoding: "utf8",
      });
      assert.equal(run2.status, 0, run2.stderr);
      assert.match(run2.stdout, /HAS_CONTEXT=true/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes unified permissionMode flags to claude, codex, and agy adapters", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-perm-"));
    try {
      const echoArgs = `console.log(JSON.stringify({ type: "delta", text: process.argv.slice(2).join(" ") }));`;
      const mockClaude = createMockBin(tmpDir, "claude", echoArgs);
      const mockCodex = createMockBin(tmpDir, "codex", echoArgs);
      const mockAgy = createMockBin(tmpDir, "agy", echoArgs);

      const ctrl = new AbortController();

      // edit mode (default): allows workspace writes/edits
      const claudeEdit = await getAdapter("claude").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "edit",
        config: { command: mockClaude, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(claudeEdit.text, /--permission-mode acceptEdits/);

      const codexEdit = await getAdapter("codex").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "edit",
        config: { command: mockCodex, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(codexEdit.text, /--sandbox workspace-write/);

      const agyEdit = await getAdapter("agy").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "edit",
        config: { command: mockAgy, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(agyEdit.text, /--mode accept-edits/);

      // full (--yolo) mode: allows writes + shell commands
      const claudeFull = await getAdapter("claude").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "full",
        config: { command: mockClaude, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(claudeFull.text, /--permission-mode bypassPermissions/);

      const codexFull = await getAdapter("codex").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "full",
        config: { command: mockCodex, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(codexFull.text, /--dangerously-bypass-approvals-and-sandbox/);

      const agyFull = await getAdapter("agy").run({
        prompt: "hi",
        rawUserPrompt: "hi",
        history: [],
        cwd: tmpDir,
        permissionMode: "full",
        config: { command: mockAgy, outputMode: "stream-json" },
        signal: ctrl.signal,
        onEvent: () => {},
      });
      assert.match(agyFull.text, /--dangerously-skip-permissions/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
