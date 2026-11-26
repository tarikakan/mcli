import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agyAdapter } from "../src/adapters/agy.ts";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { parseCliArgs, parseInlineInput } from "../src/cli-args.ts";
import { createDefaultConfig } from "../src/config.ts";
import { runAgentDiscussion } from "../src/discussion.ts";
import { detectPermissionRequest, filterExistingDirs } from "../src/permissions.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeCliScript(dir: string, name: string, body: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return filePath;
}

test("detectPermissionRequest detects external volume Read access request", () => {
  const detected = detectPermissionRequest({
    text: "I need Read access to  /Volumes/DataDrive/Research/Project_Tool . Please grant it to continue.",
    cwd: "/Users/alice/workspace/paper",
    alreadyAllowedDirs: [],
    currentPerm: "edit",
  });

  assert.ok(detected, "expected permission request to be detected");
  assert.deepEqual(detected.requestedDirs, ["/Volumes/DataDrive/Research/Project_Tool"]);
  assert.equal(detected.needsFullPerm, false);
  assert.match(detected.excerpt, /Read access to/i);
});

test("detectPermissionRequest converts file paths to parent dir and ignores cwd or already-allowed dirs", () => {
  const cwd = "/Users/alice/project";
  const detected = detectPermissionRequest({
    text: "Permission wasn't granted to read /Volumes/Data/run1/results.json and /Users/alice/project/README.md",
    cwd,
    alreadyAllowedDirs: [],
    currentPerm: "edit",
  });

  assert.ok(detected);
  assert.deepEqual(detected.requestedDirs, ["/Volumes/Data/run1"]);

  // Once already allowed, should not re-trigger for the same directory
  const suppressed = detectPermissionRequest({
    text: "Read access to /Volumes/Data/run1/results.json",
    cwd,
    alreadyAllowedDirs: ["/Volumes/Data/run1"],
    currentPerm: "edit",
  });
  assert.equal(suppressed, undefined);
});

test("detectPermissionRequest detects shell command blocks and sets needsFullPerm", () => {
  const detected = detectPermissionRequest({
    text: "The shell copy (cp) was blocked because the permission wasn't granted.",
    cwd: "/Users/alice/project",
    alreadyAllowedDirs: [],
    currentPerm: "edit",
  });

  assert.ok(detected);
  assert.deepEqual(detected.requestedDirs, []);
  assert.equal(detected.needsFullPerm, true);

  // Already in full mode should not re-trigger for shell-only block
  const alreadyFull = detectPermissionRequest({
    text: "The shell copy (cp) was blocked because the permission wasn't granted.",
    cwd: "/Users/alice/project",
    alreadyAllowedDirs: [],
    currentPerm: "full",
  });
  assert.equal(alreadyFull, undefined);
});

test("parseCliArgs and parseInlineInput parse repeatable --add-dir / --allow-dir flags", () => {
  const cli = parseCliArgs([
    "--claude",
    "--add-dir",
    "/Volumes/DataDrive/Research/Project_Tool",
    "--allow-dir=/tmp/shared",
    "compare results",
  ]);
  assert.deepEqual(cli.addDirs, ["/Volumes/DataDrive/Research/Project_Tool", "/tmp/shared"]);
  assert.equal(cli.prompt, "compare results");
  assert.deepEqual(cli.unknownFlags, []);

  const inline = parseInlineInput(
    "--codex --claude --discuss --add-dir /Volumes/DataDrive/Research/Project_Tool inspect data",
  );
  assert.deepEqual(inline.addDirs, ["/Volumes/DataDrive/Research/Project_Tool"]);
  assert.equal(inline.discuss, true);
  assert.equal(inline.prompt, "inspect data");
});

test("claude, codex, and agy adapters pass repeatable --add-dir only for existing directories", async () => {
  const tmpDir = makeTempDir("mcli-adddir-");
  const extraDir = makeTempDir("mcli-ext-");
  const missingDir = path.join(tmpDir, "does-not-exist-yet");

  try {
    assert.deepEqual(filterExistingDirs([extraDir, missingDir], tmpDir), [extraDir]);

    const fakeBin = makeFakeCliScript(
      tmpDir,
      "echo-args.mjs",
      `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");`,
    );

    const claudeRes = await claudeAdapter.run({
      prompt: "hi",
      rawUserPrompt: "hi",
      history: [],
      cwd: tmpDir,
      allowedDirs: [extraDir, missingDir],
      config: { command: fakeBin, outputMode: "text" },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const claudeArgs = JSON.parse(claudeRes.text.trim()) as string[];
    const claudeIdx = claudeArgs.indexOf("--add-dir");
    assert.notEqual(claudeIdx, -1, "claude should pass --add-dir");
    assert.equal(claudeArgs[claudeIdx + 1], extraDir);
    assert.equal(claudeArgs.includes(missingDir), false);

    const codexRes = await codexAdapter.run({
      prompt: "hi",
      rawUserPrompt: "hi",
      history: [],
      cwd: tmpDir,
      allowedDirs: [extraDir, missingDir],
      config: { command: fakeBin, outputMode: "text" },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const codexArgs = JSON.parse(codexRes.text.trim()) as string[];
    const codexIdx = codexArgs.indexOf("--add-dir");
    assert.notEqual(codexIdx, -1, "codex should pass --add-dir");
    assert.equal(codexArgs[codexIdx + 1], extraDir);
    assert.equal(codexArgs.includes(missingDir), false);

    const agyRes = await agyAdapter.run({
      prompt: "hi",
      rawUserPrompt: "hi",
      history: [],
      cwd: tmpDir,
      allowedDirs: [extraDir, missingDir],
      config: { command: fakeBin, outputMode: "text" },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const agyArgs = JSON.parse(agyRes.text.trim()) as string[];
    const agyIdx = agyArgs.indexOf("--add-dir");
    assert.notEqual(agyIdx, -1, "agy should pass --add-dir");
    assert.equal(agyArgs[agyIdx + 1], extraDir);
    assert.equal(agyArgs.includes(missingDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("runAgentDiscussion prompts mid-discussion on external path block, retries immediately, and shares approval with Round 2", async () => {
  const tmpDir = makeTempDir("mcli-disc-perm-");
  const externalDir = makeTempDir("mcli-ext-vol-");

  try {
    // Fake agent script: blocks until --add-dir <externalDir> is passed, then returns verified data.
    const fakeAgent = makeFakeCliScript(
      tmpDir,
      "fake-agent.mjs",
      `
const args = process.argv.slice(2);
const addDirIdx = args.indexOf("--add-dir");
const allowed = addDirIdx !== -1 ? args[addDirIdx + 1] : "";
const pIdx = args.indexOf("-p");
const prompt = pIdx !== -1 ? args[pIdx + 1] : args[args.length - 1] || "";
const isRound2 = prompt.includes('round="2"');
const isSynth = prompt.includes("<agent_discussion_transcript>");
if (allowed !== ${JSON.stringify(externalDir)}) {
  process.stdout.write("Read access to  " + ${JSON.stringify(externalDir)} + " .\\n");
} else if (isSynth) {
  process.stdout.write("Synthesis with external dir verified.\\n");
} else if (isRound2) {
  process.stdout.write("Round 2 peer review with external dir OK.\\n");
} else {
  process.stdout.write("Round 1 analysis read external dir successfully.\\n");
}
`,
    );

    const config = createDefaultConfig();
    config.agents.claude = { command: fakeAgent, outputMode: "text" };
    config.agents.codex = { command: fakeAgent, outputMode: "text" };

    let approvalCalls = 0;
    const requestedPathsSeen: string[][] = [];

    const result = await runAgentDiscussion({
      targets: [
        { agent: "claude", model: "opus" },
        { agent: "codex", model: "o3" },
      ],
      userPrompt: "Analyze dataset in external volume",
      history: [],
      cwd: tmpDir,
      config,
      rounds: 2,
      synthesize: true,
      signal: new AbortController().signal,
      parallel: true,
      onPermissionRequest: async ({ request }) => {
        approvalCalls++;
        requestedPathsSeen.push(request.requestedDirs);
        return "session";
      },
    });

    // Both claude and codex blocked in Round 1 on the SAME externalDir,
    // so approving "session" on the first should automatically retry the second without asking twice!
    assert.equal(approvalCalls, 1, "should ask user only once when approved for session");
    assert.deepEqual(requestedPathsSeen, [[externalDir]]);

    // Round 1 (2 msgs) + Round 2 (2 msgs) + Synthesis (1 msg) = 5 messages, all succeeded
    assert.equal(result.messages.length, 5);
    assert.match(result.messages[0].content, /Round 1 analysis read external dir successfully/);
    assert.match(result.messages[1].content, /Round 1 analysis read external dir successfully/);
    assert.match(result.messages[2].content, /Round 2 peer review with external dir OK/);
    assert.match(result.messages[3].content, /Round 2 peer review with external dir OK/);
    assert.match(result.messages[4].content, /Synthesis with external dir verified/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});
