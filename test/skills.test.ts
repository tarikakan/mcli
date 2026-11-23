import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCliArgs, parseInlineInput } from "../src/cli-args.ts";
import {
  buildSkillsPromptBlock,
  discoverSkills,
  parseSkillFrontmatter,
  resolveRequestedSkills,
} from "../src/skills.ts";

function writeSkill(root: string, folder: string, content: string): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "SKILL.md");
  fs.writeFileSync(filePath, content, "utf8");
  return dir;
}

describe("unified cross-CLI skills", () => {
  it("parses YAML frontmatter including multi-line folded descriptions", () => {
    const raw = [
      "---",
      "name: heavy-quark-audit",
      "description: >",
      "  Verify heavy quark renormalization",
      "  and mass-scheme consistency.",
      "---",
      "",
      "# Instructions",
      "Always check MS-bar vs pole mass.",
    ].join("\n");

    const parsed = parseSkillFrontmatter(raw, "fallback");
    assert.equal(parsed.name, "heavy-quark-audit");
    assert.equal(
      parsed.description,
      "Verify heavy quark renormalization and mass-scheme consistency.",
    );
    assert.match(parsed.body, /Always check MS-bar vs pole mass/);
  });

  it("discovers skills across claude, codex, and workspace dirs with workspace overriding duplicates", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-skills-"));
    try {
      const wsDir = path.join(tmp, "repo");
      const claudeSkills = path.join(wsDir, ".claude", "skills");
      const codexSkills = path.join(wsDir, ".codex", "skills");
      const mcliSkills = path.join(wsDir, ".mcli", "skills");

      writeSkill(
        claudeSkills,
        "claude-only",
        "---\nname: claude-only\ndescription: From Claude\n---\nUse Claude workflow.",
      );
      writeSkill(
        codexSkills,
        "codex-only",
        "---\nname: codex-only\ndescription: From Codex\n---\nUse Codex workflow.",
      );
      writeSkill(
        claudeSkills,
        "shared-skill",
        "---\nname: shared-skill\ndescription: Lower priority\n---\nOLD_BODY",
      );
      writeSkill(
        mcliSkills,
        "shared-skill",
        "---\nname: shared-skill\ndescription: Higher priority workspace override\n---\nNEW_WORKSPACE_BODY",
      );

      const skills = discoverSkills(wsDir);
      assert.ok(skills.some((s) => s.name === "claude-only" && s.source === "workspace/claude"));
      assert.ok(skills.some((s) => s.name === "codex-only" && s.source === "workspace/codex"));

      const shared = skills.find((s) => s.name === "shared-skill");
      assert.ok(shared);
      assert.equal(shared.body, "NEW_WORKSPACE_BODY");

      const { resolved, missing } = resolveRequestedSkills(
        ["claude-only", "codex-only", "nonexistent"],
        skills,
      );
      assert.equal(resolved.length, 2);
      assert.deepEqual(missing, ["nonexistent"]);

      const block = buildSkillsPromptBlock(resolved);
      assert.match(block, /<active_skills count="2">/);
      assert.match(block, /<active_skill name="claude-only"/);
      assert.match(block, /Use Codex workflow\./);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses --skills, --skill <name>, and $<name> on CLI and inline without colliding with model flags", () => {
    const cli = parseCliArgs([
      "--codex",
      "--gpt-5.6-sol",
      "--claude",
      "--opus",
      "--skill",
      "heavy-quark-audit",
      "--agent",
      "discussion",
      "investigate",
    ]);
    assert.deepEqual(cli.targets, [
      { agent: "codex", model: "gpt-5.6-sol" },
      { agent: "claude", model: "opus" },
    ]);
    assert.deepEqual(cli.skills, ["heavy-quark-audit"]);
    assert.equal(cli.discuss, true);
    assert.equal(cli.prompt, "investigate");

    // --codex --skill foo should NOT mistake --skill for a model name!
    const cli2 = parseCliArgs(["--codex", "--skill", "my-skill", "do task"]);
    assert.deepEqual(cli2.targets, [{ agent: "codex", model: undefined }]);
    assert.deepEqual(cli2.skills, ["my-skill"]);
    assert.equal(cli2.prompt, "do task");

    const inline = parseInlineInput("$claude-review --codex fix bug");
    assert.deepEqual(inline.skills, ["claude-review"]);
    assert.deepEqual(inline.targets, [{ agent: "codex", model: undefined }]);
    assert.equal(inline.prompt, "fix bug");

    const listInline = parseInlineInput("--skills");
    assert.equal(listInline.listSkills, true);
  });

  it("injects a Claude skill into a Codex CLI run end-to-end", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-skill-e2e-"));
    try {
      const wsDir = path.join(tmp, "project");
      writeSkill(
        path.join(wsDir, ".claude", "skills"),
        "physics-check",
        "---\nname: physics-check\ndescription: Physics sanity checks\n---\nVERIFY_UNITARITY_RULE_99",
      );

      const mockCodex = path.join(tmp, "codex");
      fs.writeFileSync(
        mockCodex,
        `#!/usr/bin/env node
        const prompt = process.argv[process.argv.length - 1];
        const hasSkill = prompt.includes("VERIFY_UNITARITY_RULE_99");
        console.log(JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "CODEX_SAW_CLAUDE_SKILL=" + hasSkill } }));
        `,
        { mode: 0o755 },
      );

      fs.writeFileSync(
        path.join(tmp, "config.json"),
        JSON.stringify({
          defaultAgent: "codex",
          agents: { codex: { command: mockCodex, outputMode: "stream-json" } },
        }),
      );

      const binPath = path.resolve(process.cwd(), "bin/mcli.mjs");
      const run = spawnSync(
        process.execPath,
        [binPath, "--codex", "--skill", "physics-check", "check cross section"],
        {
          cwd: wsDir,
          env: { ...process.env, MCLI_HOME: tmp },
          encoding: "utf8",
        },
      );

      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /CODEX_SAW_CLAUDE_SKILL=true/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
