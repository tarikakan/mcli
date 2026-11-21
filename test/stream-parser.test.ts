import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStreamParserState,
  parseNdjsonLine,
  parseOpenAiSseLine,
} from "../src/stream-parser.ts";

describe("parseNdjsonLine", () => {
  it("parses Claude stream-json deltas without duplicating final assistant/result text", () => {
    const state = createStreamParserState();

    const e1 = parseNdjsonLine(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      }),
      state,
      "claude",
    );
    const e2 = parseNdjsonLine(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      }),
      state,
      "claude",
    );
    const e3 = parseNdjsonLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/index.ts" } },
            { type: "text", text: "Hello world" },
          ],
        },
      }),
      state,
      "claude",
    );
    const e4 = parseNdjsonLine(
      JSON.stringify({ type: "result", session_id: "sess-123", result: "Hello world" }),
      state,
      "claude",
    );

    assert.deepEqual(e1, [{ type: "text", text: "Hello " }]);
    assert.deepEqual(e2, [{ type: "text", text: "world" }]);
    assert.deepEqual(e3, [{ type: "tool", toolName: "Read", toolDetail: "src/index.ts" }]);
    assert.equal(state.emittedText, "Hello world");
    assert.ok(e4.some((e) => e.type === "session" && e.sessionId === "sess-123"));
    assert.ok(e4.some((e) => e.type === "done"));
  });

  it("parses Codex exec --json events", () => {
    const state = createStreamParserState();

    const e1 = parseNdjsonLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "cmd1", type: "command_execution", command: "npm test" },
      }),
      state,
      "codex",
    );
    const e2 = parseNdjsonLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg1", type: "agent_message", text: "All tests pass." },
      }),
      state,
      "codex",
    );

    assert.deepEqual(e1, [{ type: "tool", toolName: "shell", toolDetail: "npm test" }]);
    assert.deepEqual(e2, [{ type: "text", text: "All tests pass." }]);
  });

  it("falls back cleanly to raw text when line is not JSON", () => {
    const state = createStreamParserState();
    const events = parseNdjsonLine("Plain text line from CLI", state, "generic");
    assert.deepEqual(events, [{ type: "text", text: "Plain text line from CLI\n" }]);
  });
});

describe("parseOpenAiSseLine", () => {
  it("parses DeepSeek SSE reasoning_content, content, and [DONE]", () => {
    const r1 = parseOpenAiSseLine(
      'data: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}',
    );
    const r2 = parseOpenAiSseLine(
      'data: {"choices":[{"delta":{"content":"Answer: 42"}}]}',
    );
    const r3 = parseOpenAiSseLine("data: [DONE]");

    assert.deepEqual(r1, [{ type: "reasoning", text: "Step 1" }]);
    assert.deepEqual(r2, [{ type: "text", text: "Answer: 42" }]);
    assert.deepEqual(r3, [{ type: "done" }]);
  });
});
