import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildPromptWithContext,
  buildSharedContextBlock,
  compactSession,
  createSession,
  exportSessionMarkdown,
  getSessionTranscriptPath,
  listSessions,
  loadOrCreateSession,
  saveSession,
  saveSessionAs,
} from "../src/session.ts";
import type { AgentAdapter, ChatMessage } from "../src/types.ts";

describe("session & 3-tier shared memory", () => {
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

  it("folds older multi-round discussions into Final Synthesis while keeping latest turn full", () => {
    const history: ChatMessage[] = [
      // Turn 1: older multi-round discussion with Final Synthesis
      { id: "u1", role: "user", content: "Investigate heavy quarks", timestamp: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", agent: "codex", model: "gpt-5.6-sol", roundLabel: "Round 1/2 · Analysis", content: "DRAFT_CODEX_R1", timestamp: "2026-01-01T00:00:01Z" },
      { id: "a2", role: "assistant", agent: "claude", model: "opus", roundLabel: "Round 1/2 · Analysis", content: "DRAFT_CLAUDE_R1", timestamp: "2026-01-01T00:00:02Z" },
      { id: "a3", role: "assistant", agent: "codex", model: "gpt-5.6-sol", roundLabel: "Final Synthesis", content: "CONSENSUS_HEAVY_QUARKS", timestamp: "2026-01-01T00:00:03Z" },
      // Turn 2: latest turn (kept verbatim)
      { id: "u2", role: "user", content: "Now focus on top quark decay", timestamp: "2026-01-01T00:01:00Z" },
      { id: "a4", role: "assistant", agent: "agy", roundLabel: "Round 1/2 · Analysis", content: "LATEST_AGY_DRAFT", timestamp: "2026-01-01T00:01:01Z" },
      { id: "a5", role: "assistant", agent: "agy", roundLabel: "Final Synthesis", content: "LATEST_AGY_SYNTH", timestamp: "2026-01-01T00:01:02Z" },
    ];

    const { contextBlock, stats } = buildSharedContextBlock({
      history,
      targetAgent: "deepseek",
      config: { shareContext: true, maxContextTurns: 10, maxContextChars: 20000 },
      transcriptPath: "/tmp/mcli/sessions/quarks.md",
    });

    assert.equal(stats.foldedDiscussions, 1);
    assert.match(contextBlock, /transcript_file="\/tmp\/mcli\/sessions\/quarks\.md"/);
    assert.match(contextBlock, /CONSENSUS_HEAVY_QUARKS/);
    assert.doesNotMatch(contextBlock, /DRAFT_CODEX_R1/);
    assert.doesNotMatch(contextBlock, /DRAFT_CLAUDE_R1/);
    // Most recent turn stays fully expanded
    assert.match(contextBlock, /LATEST_AGY_DRAFT/);
    assert.match(contextBlock, /LATEST_AGY_SYNTH/);
  });

  it("injects rolling summary and auto-digests overflow turns so nothing is silently lost", () => {
    const history: ChatMessage[] = [
      { id: "u1", role: "user", content: "Turn 1: charm quark mass", timestamp: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", agent: "claude", content: "CHARM_MASS_FACT " + "x".repeat(500), timestamp: "2026-01-01T00:00:01Z" },
      { id: "u2", role: "user", content: "Turn 2: bottom quark", timestamp: "2026-01-01T00:00:02Z" },
      { id: "a2", role: "assistant", agent: "codex", content: "BOTTOM_MASS_FACT " + "y".repeat(500), timestamp: "2026-01-01T00:00:03Z" },
      { id: "u3", role: "user", content: "Turn 3: top quark", timestamp: "2026-01-01T00:00:04Z" },
      { id: "a3", role: "assistant", agent: "agy", content: "TOP_MASS_FACT", timestamp: "2026-01-01T00:00:05Z" },
    ];

    const { contextBlock, stats } = buildSharedContextBlock({
      history,
      targetAgent: "kimi",
      config: { shareContext: true, maxContextTurns: 2, maxContextChars: 4000 },
      sessionSummary: "Earlier: agreed on MS-bar renormalization scheme.",
    });

    assert.equal(stats.overflowDigestedTurns, 1);
    assert.match(contextBlock, /<earlier_conversation_summary>/);
    assert.match(contextBlock, /MS-bar renormalization scheme/);
    assert.match(contextBlock, /<older_turns_digest count="1">/);
    assert.match(contextBlock, /CHARM_MASS_FACT/);
    assert.match(contextBlock, /TOP_MASS_FACT/);
  });

  it("persists JSON + auto-synced Markdown transcript, snapshots via saveSessionAs, and compacts", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-test-"));
    const prevHome = process.env.MCLI_HOME;
    process.env.MCLI_HOME = tmpHome;

    try {
      const session = createSession({ name: "my-chat", cwd: "/tmp/project", activeAgent: "claude" });
      session.messages.push(
        { id: "u1", role: "user", agent: "claude", content: "Turn 1", timestamp: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "assistant", agent: "claude", content: "Answer 1", timestamp: "2026-01-01T00:00:01Z" },
        { id: "u2", role: "user", agent: "codex", content: "Turn 2", timestamp: "2026-01-01T00:00:02Z" },
        { id: "a2", role: "assistant", agent: "codex", content: "Answer 2", timestamp: "2026-01-01T00:00:03Z" },
        { id: "u3", role: "user", agent: "agy", content: "Turn 3", timestamp: "2026-01-01T00:00:04Z" },
        { id: "a3", role: "assistant", agent: "agy", content: "Answer 3", timestamp: "2026-01-01T00:00:05Z" },
      );
      saveSession(session);

      // Tier 3 auto-synced Markdown transcript exists on disk
      const mdPath = getSessionTranscriptPath(session.id);
      assert.ok(fs.existsSync(mdPath));
      const mdOnDisk = fs.readFileSync(mdPath, "utf8");
      assert.match(mdOnDisk, /# mcli Session: my-chat/);
      assert.match(mdOnDisk, /Answer 1/);

      // Snapshot via saveSessionAs
      const snap = saveSessionAs(session, "quark-checkpoint");
      assert.equal(snap.id, "quark-checkpoint");
      assert.ok(fs.existsSync(getSessionTranscriptPath("quark-checkpoint")));

      // Compact older turns using a mock agent adapter (keeps last 2 turns verbatim)
      const mockAdapter: AgentAdapter = {
        id: "claude",
        detect: () => ({ id: "claude", available: true, mode: "cli", detail: "mock" }),
        run: async () => ({
          text: "- Goal: Turn 1 established Answer 1.",
          reasoning: "",
          tools: [],
          durationMs: 5,
        }),
      };

      const compacted = await compactSession({
        session,
        cwd: "/tmp/project",
        keepRecentTurns: 2,
        adapter: mockAdapter,
      });

      assert.equal(compacted.compactedTurns, 1);
      assert.equal(compacted.mode, "agent");
      assert.equal(session.summarizedUpTo, 2);
      assert.match(session.summary ?? "", /Answer 1/);

      const loaded = loadOrCreateSession({ name: "my-chat", cwd: "/tmp/project", activeAgent: "codex" });
      assert.equal(loaded.messages.length, 6);
      assert.equal(loaded.summarizedUpTo, 2);

      const all = listSessions();
      assert.equal(all.length, 2);
      assert.ok(all.some((s) => s.id === "my-chat" && s.hasSummary));

      const md = exportSessionMarkdown(loaded);
      assert.match(md, /## Rolling Memory Summary/);
    } finally {
      if (prevHome === undefined) delete process.env.MCLI_HOME;
      else process.env.MCLI_HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
