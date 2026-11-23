import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractSelectionText,
  findWordBounds,
  highlightVisibleRange,
  normalizeSelection,
  renderMarkdownLines,
  stripAnsi,
  truncateVisible,
  wrapPlainText,
} from "../src/ui/ansi.ts";
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

  it("parses SGR and X10 mouse wheel, press, drag, and release sequences cleanly", () => {
    assert.deepEqual(parseMouseSequence("\x1b[<64;20;10Mrest"), {
      length: 12,
      wheel: "up",
      col: 20,
      row: 10,
    });
    assert.deepEqual(parseMouseSequence("\x1b[<65;20;10Mrest"), {
      length: 12,
      wheel: "down",
      col: 20,
      row: 10,
    });
    assert.deepEqual(parseMouseSequence("\x1b[<0;12;4M"), {
      length: 10,
      kind: "press",
      button: 0,
      col: 12,
      row: 4,
    });
    assert.deepEqual(parseMouseSequence("\x1b[<32;18;4M"), {
      length: 11,
      kind: "drag",
      button: 0,
      col: 18,
      row: 4,
    });
    assert.deepEqual(parseMouseSequence("\x1b[<0;18;4m"), {
      length: 10,
      kind: "release",
      button: 0,
      col: 18,
      row: 4,
    });
    // Legacy X10 wheel up (64 + 32 = 96 = '`') & wheel down (65 + 32 = 97 = 'a')
    assert.deepEqual(parseMouseSequence("\x1b[M`!!"), {
      length: 6,
      wheel: "up",
      col: 1,
      row: 1,
    });
    assert.deepEqual(parseMouseSequence("\x1b[Ma!!"), {
      length: 6,
      wheel: "down",
      col: 1,
      row: 1,
    });
    assert.equal(parseMouseSequence("\x1b[A"), undefined);
  });

  it("highlights visible ranges across ANSI codes and extracts multi-line & word selections", () => {
    const colored = "\x1b[32mhello\x1b[0m world";
    const highlighted = highlightVisibleRange(colored, 2, 7);
    assert.equal(stripAnsi(highlighted), "hello world");
    assert.ok(highlighted.includes("\x1b[7m"));
    assert.ok(highlighted.includes("\x1b[27m"));

    const lines = ["    The top quark is heavy.", "    Its mass is ~173 GeV."];
    // Backward drag from line 1 col 11 to line 0 col 8
    const norm = normalizeSelection({
      anchorLine: 1,
      anchorCol: 11,
      focusLine: 0,
      focusCol: 8,
    });
    assert.equal(extractSelectionText(lines, norm), "top quark is heavy.\n    Its mass");

    const word = findWordBounds("    heavy-quarks are interesting", 10);
    assert.deepEqual(word, { start: 4, end: 15 });
    assert.equal("    heavy-quarks are interesting".slice(word!.start, word!.end + 1), "heavy-quarks");
  });
});
