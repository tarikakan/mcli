import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdownLines, stripAnsi, truncateVisible, wrapPlainText } from "../src/ui/ansi.ts";
import { parseMouseSequence } from "../src/ui/tui.ts";

describe("ansi & markdown helpers", () => {
  it("wraps long plain lines within max width", () => {
    const lines = wrapPlainText("one two three four five six", 12);
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.ok(line.length <= 12, `line too long: ${line}`);
    }
  });

  it("renders markdown headings, bullets, and fenced code blocks", () => {
    const md = [
      "## Summary",
      "- Use `--claude` or `--codex`",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const lines = renderMarkdownLines(md, 60, "  ").map(stripAnsi);
    assert.ok(lines.some((l) => l.includes("Summary")));
    assert.ok(lines.some((l) => l.includes("•") && l.includes("--claude")));
    assert.ok(lines.some((l) => l.includes("╭─ ts")));
    assert.ok(lines.some((l) => l.includes("│ const x = 1;")));
  });

  it("truncates ANSI text by visible width", () => {
    const truncated = truncateVisible("\x1b[32mhello world\x1b[0m", 6);
    assert.equal(stripAnsi(truncated), "hello…");
  });

  it("parses SGR and X10 mouse wheel sequences cleanly", () => {
    assert.deepEqual(parseMouseSequence("\x1b[<64;20;10Mrest"), { length: 12, wheel: "up" });
    assert.deepEqual(parseMouseSequence("\x1b[<65;20;10Mrest"), { length: 12, wheel: "down" });
    // Regular mouse click / release is consumed without leaking characters
    assert.deepEqual(parseMouseSequence("\x1b[<0;12;4M"), { length: 10 });
    assert.deepEqual(parseMouseSequence("\x1b[<0;12;4m"), { length: 10 });
    // Legacy X10 wheel up (64 + 32 = 96 = '`') & wheel down (65 + 32 = 97 = 'a')
    assert.deepEqual(parseMouseSequence("\x1b[M`!!"), { length: 6, wheel: "up" });
    assert.deepEqual(parseMouseSequence("\x1b[Ma!!"), { length: 6, wheel: "down" });
    assert.equal(parseMouseSequence("\x1b[A"), undefined);
  });
});
