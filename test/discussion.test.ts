import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliArgs, parseInlineInput } from "../src/cli-args.ts";
import { createDefaultConfig } from "../src/config.ts";
import { runAgentDiscussion } from "../src/discussion.ts";

function createMockBin(dir: string, name: string, scriptBody: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
  return filePath;
}

describe("multi-firm/model parsing & --agent discussion", () => {
  it("parses --codex --gpt-5.6-sol --claude --opus --agent discussion on CLI", () => {
    const cli = parseCliArgs([
      "--codex",
      "--gpt-5.6-sol",
      "--claude",
      "--opus",
      "--agent",
      "discussion",
      "investigate",
      "the",
      "heavy",
      "quarks",
    ]);

    assert.deepEqual(cli.targets, [
      { agent: "codex", model: "gpt-5.6-sol" },
      { agent: "claude", model: "opus" },
    ]);
    assert.equal(cli.discuss, true);
    assert.equal(cli.prompt, "investigate the heavy quarks");
    assert.deepEqual(cli.unknownFlags, []);
  });

  it("parses flags placed mid-sentence or at the end of inline input", () => {
    const inline = parseInlineInput(
      "investigate the heavy quarks --codex --gpt-5.6-sol --claude --opus --agent discussion --rounds 3",
    );
    assert.deepEqual(inline.targets, [
      { agent: "codex", model: "gpt-5.6-sol" },
      { agent: "claude", model: "opus" },
    ]);
    assert.equal(inline.discuss, true);
    assert.equal(inline.discussionRounds, 3);
    assert.equal(inline.prompt, "investigate the heavy quarks");
  });

  it("supports selecting two different models from the same firm", () => {
    const inline = parseInlineInput("--claude --opus --claude --sonnet --discuss compare approaches");
    assert.deepEqual(inline.targets, [
      { agent: "claude", model: "opus" },
      { agent: "claude", model: "sonnet" },
    ]);
    assert.equal(inline.discuss, true);
    assert.equal(inline.prompt, "compare approaches");
  });

  it("runs multi-round peer discussion and synthesis passing peer outputs to Round 2", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-disc-"));
    try {
      const mockCodex = createMockBin(
        tmpDir,
        "codex",
        `
        const args = process.argv.slice(2);
        const modelIdx = args.indexOf("--model");
        const model = modelIdx !== -1 ? args[modelIdx + 1] : "default";
        const prompt = args[args.length - 1];
        let reply;
        if (prompt.includes("Instructions for Final Synthesis")) {
          reply = "SYNTHESIS(" + model + "): saw_codex=" + prompt.includes("CODEX_R1_QUARK") + " saw_claude=" + prompt.includes("CLAUDE_R1_QUARK");
        } else if (prompt.includes("<agent_discussion")) {
          reply = "CODEX_R2(" + model + "): reviewed_claude=" + prompt.includes("CLAUDE_R1_QUARK");
        } else {
          reply = "CODEX_R1_QUARK(" + model + ")";
        }
        console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: reply } }));
        `,
      );
      const mockClaude = createMockBin(
        tmpDir,
        "claude",
        `
        const args = process.argv.slice(2);
        const modelIdx = args.indexOf("--model");
        const model = modelIdx !== -1 ? args[modelIdx + 1] : "default";
        const pIdx = args.indexOf("-p");
        const prompt = pIdx !== -1 ? args[pIdx + 1] : "";
        let reply;
        if (prompt.includes("<agent_discussion")) {
          reply = "CLAUDE_R2(" + model + "): reviewed_codex=" + prompt.includes("CODEX_R1_QUARK");
        } else {
          reply = "CLAUDE_R1_QUARK(" + model + ")";
        }
        console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }));
        `,
      );

      const config = createDefaultConfig();
      config.agents.codex = { command: mockCodex, outputMode: "stream-json" };
      config.agents.claude = { command: mockClaude, outputMode: "stream-json" };

      const roundsSeen: string[] = [];
      const controller = new AbortController();

      const res = await runAgentDiscussion({
        targets: [
          { agent: "codex", model: "gpt-5.6-sol" },
          { agent: "claude", model: "opus" },
        ],
        userPrompt: "investigate the heavy quarks",
        history: [],
        cwd: tmpDir,
        config,
        rounds: 2,
        synthesize: true,
        signal: controller.signal,
        onRoundStart: ({ roundLabel }) => roundsSeen.push(roundLabel),
      });

      assert.equal(res.hadError, false);
      assert.deepEqual(roundsSeen, [
        "Round 1/2 · Analysis",
        "Round 2/2 · Discussion",
        "Final Synthesis",
      ]);
      // 2 in Round 1 + 2 in Round 2 + 1 Final Synthesis = 5 messages
      assert.equal(res.messages.length, 5);
      assert.equal(res.messages[0].content, "CODEX_R1_QUARK(gpt-5.6-sol)");
      assert.equal(res.messages[1].content, "CLAUDE_R1_QUARK(opus)");
      assert.equal(res.messages[2].content, "CODEX_R2(gpt-5.6-sol): reviewed_claude=true");
      assert.equal(res.messages[3].content, "CLAUDE_R2(opus): reviewed_codex=true");
      assert.equal(
        res.messages[4].content,
        "SYNTHESIS(gpt-5.6-sol): saw_codex=true saw_claude=true",
      );
      assert.equal(res.messages[4].roundLabel, "Final Synthesis");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("works end-to-end via mcli CLI with --codex --gpt-5.6-sol --claude --opus --agent discussion", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-disc-cli-"));
    try {
      const mockCodex = createMockBin(
        tmpDir,
        "codex",
        `
        const args = process.argv.slice(2);
        const model = args[args.indexOf("--model") + 1];
        const prompt = args[args.length - 1];
        const tag = prompt.includes("Final Synthesis") ? "FINAL" : prompt.includes("<agent_discussion") ? "R2" : "R1";
        console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "CODEX_" + tag + "_" + model } }));
        `,
      );
      const mockClaude = createMockBin(
        tmpDir,
        "claude",
        `
        const args = process.argv.slice(2);
        const model = args[args.indexOf("--model") + 1];
        const prompt = args[args.indexOf("-p") + 1];
        const tag = prompt.includes("<agent_discussion") ? "R2" : "R1";
        console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "CLAUDE_" + tag + "_" + model }] } }));
        `,
      );

      fs.writeFileSync(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          defaultAgent: "codex",
          agents: {
            codex: { command: mockCodex, outputMode: "stream-json" },
            claude: { command: mockClaude, outputMode: "stream-json" },
          },
        }),
      );

      const binPath = path.resolve(process.cwd(), "bin/mcli.mjs");
      const run = spawnSync(
        process.execPath,
        [
          binPath,
          "--codex",
          "--gpt-5.6-sol",
          "--claude",
          "--opus",
          "--agent",
          "discussion",
          "investigate the heavy quarks",
        ],
        {
          env: { ...process.env, MCLI_HOME: tmpDir },
          encoding: "utf8",
        },
      );

      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /CODEX_R1_gpt-5\.6-sol/);
      assert.match(run.stdout, /CLAUDE_R1_opus/);
      assert.match(run.stdout, /CODEX_R2_gpt-5\.6-sol/);
      assert.match(run.stdout, /CLAUDE_R2_opus/);
      assert.match(run.stdout, /CODEX_FINAL_gpt-5\.6-sol/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
