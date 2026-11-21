import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildPromptWithContext,
  createSession,
  exportSessionMarkdown,
  listSessions,
  loadOrCreateSession,
  saveSession,
} from "../src/session.ts";
import type { ChatMessage } from "../src/types.ts";

describe("session & shared context", () => {
  it("builds cross-agent context block preserving speaker labels and tools", () => {
    const history: ChatMessage[] = [
      {
        id: "1",
        role: "user",
        agent: "claude",
        content: "Inspect auth.ts for bugs",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        id: "2",
        role: "assistant",
        agent: "claude",
        content: "Found a missing null check on line 42.",
        tools: [{ name: "Read", detail: "src/auth.ts" }],
        timestamp: "2026-01-01T00:00:02Z",
      },
    ];

    const prompt = buildPromptWithContext({
      userPrompt: "Now write a fix and test for it",
      history,
      targetAgent: "codex",
      config: { shareContext: true, maxContextTurns: 10, maxContextChars: 10000 },
    });

    assert.match(prompt, /<shared_conversation_history>/);
    assert.match(prompt, /routed the next turn to Codex/);
    assert.match(prompt, /### User\nInspect auth\.ts for bugs/);
    assert.match(prompt, /### Assistant \(Claude\)/);
    assert.match(prompt, /\[Tools used: Read\(src\/auth\.ts\)\]/);
    assert.match(prompt, /User's current request:\nNow write a fix and test for it/);
  });

  it("returns raw prompt when shareContext is disabled or history is empty", () => {
    const prompt = buildPromptWithContext({
      userPrompt: "Hello",
      history: [],
      targetAgent: "agy",
      config: { shareContext: true, maxContextTurns: 10, maxContextChars: 10000 },
    });
    assert.equal(prompt, "Hello");

    const noCtx = buildPromptWithContext({
      userPrompt: "Hello",
      history: [
        { id: "1", role: "user", content: "Prior", timestamp: "2026-01-01T00:00:00Z" },
      ],
      targetAgent: "agy",
      config: { shareContext: false, maxContextTurns: 10, maxContextChars: 10000 },
    });
    assert.equal(noCtx, "Hello");
  });

  it("persists, reloads, lists, and exports sessions using MCLI_HOME", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-test-"));
    const prevHome = process.env.MCLI_HOME;
    process.env.MCLI_HOME = tmpHome;

    try {
      const session = createSession({ name: "my-chat", cwd: "/tmp/project", activeAgent: "claude" });
      session.messages.push(
        { id: "u1", role: "user", agent: "claude", content: "Hi", timestamp: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", agent: "claude", content: "Hello!", timestamp: "2026-01-01T00:00:01Z" },
      );
      saveSession(session);

      const loaded = loadOrCreateSession({ name: "my-chat", cwd: "/tmp/project", activeAgent: "codex" });
      assert.equal(loaded.messages.length, 2);
      assert.equal(loaded.messages[1].content, "Hello!");

      const all = listSessions();
      assert.equal(all.length, 1);
      assert.equal(all[0].id, "my-chat");

      const md = exportSessionMarkdown(loaded);
      assert.match(md, /# mcli Session: my-chat/);
      assert.match(md, /## Claude/);
    } finally {
      if (prevHome === undefined) delete process.env.MCLI_HOME;
      else process.env.MCLI_HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
