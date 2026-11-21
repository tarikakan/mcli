import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs, parseInlineInput } from "../src/cli-args.ts";

describe("parseCliArgs", () => {
  it("parses single agent flag and prompt", () => {
    const parsed = parseCliArgs(["--codex", "fix", "the", "tests"]);
    assert.deepEqual(parsed.agents, ["codex"]);
    assert.equal(parsed.prompt, "fix the tests");
    assert.deepEqual(parsed.unknownFlags, []);
  });

  it("supports all 5 agent flags and deduplicates", () => {
    const parsed = parseCliArgs([
      "--claude",
      "--codex",
      "--agy",
      "--deepseek",
      "--kimi",
      "--claude",
      "compare",
    ]);
    assert.deepEqual(parsed.agents, ["claude", "codex", "agy", "deepseek", "kimi"]);
    assert.equal(parsed.prompt, "compare");
  });

  it("parses options like --model, --session, --plain, --status", () => {
    const parsed = parseCliArgs([
      "--deepseek",
      "--model",
      "deepseek-reasoner",
      "--session=arch-review",
      "--plain",
      "--no-context",
      "analyze this",
    ]);
    assert.deepEqual(parsed.agents, ["deepseek"]);
    assert.equal(parsed.model, "deepseek-reasoner");
    assert.equal(parsed.session, "arch-review");
    assert.equal(parsed.plain, true);
    assert.equal(parsed.noContext, true);
    assert.equal(parsed.prompt, "analyze this");
  });

  it("records unknown leading flags without crashing", () => {
    const parsed = parseCliArgs(["--bogus", "hello"]);
    assert.deepEqual(parsed.unknownFlags, ["--bogus"]);
    assert.equal(parsed.prompt, "hello");
  });
});

describe("parseInlineInput", () => {
  it("parses inline --agent flag with prompt", () => {
    const parsed = parseInlineInput("--claude explain what codex just changed");
    assert.deepEqual(parsed.agents, ["claude"]);
    assert.equal(parsed.prompt, "explain what codex just changed");
    assert.equal(parsed.switchOnly, false);
    assert.equal(parsed.isSlashCommand, false);
  });

  it("detects switch-only agent flag", () => {
    const parsed = parseInlineInput("--kimi");
    assert.deepEqual(parsed.agents, ["kimi"]);
    assert.equal(parsed.prompt, "");
    assert.equal(parsed.switchOnly, true);
  });

  it("supports multi-agent inline routing and @aliases", () => {
    const parsed = parseInlineInput("--agy @deepseek review this PR");
    assert.deepEqual(parsed.agents, ["agy", "deepseek"]);
    assert.equal(parsed.prompt, "review this PR");
    assert.equal(parsed.switchOnly, false);
  });

  it("parses slash commands", () => {
    const parsed = parseInlineInput("/session load feature-auth");
    assert.equal(parsed.isSlashCommand, true);
    assert.equal(parsed.command, "session");
    assert.equal(parsed.commandArgs, "load feature-auth");
  });
});
