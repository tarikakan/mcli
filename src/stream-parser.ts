import type { StreamEvent } from "./types.ts";

export interface StreamParserState {
  emittedText: string;
  emittedReasoning: string;
  sawDeltaText: boolean;
  sawJsonLine: boolean;
  seenToolKeys: Set<string>;
}

export function createStreamParserState(): StreamParserState {
  return {
    emittedText: "",
    emittedReasoning: "",
    sawDeltaText: false,
    sawJsonLine: false,
    seenToolKeys: new Set<string>(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return truncateInline(input, 80);
  const rec = asRecord(input);
  if (!rec) return undefined;
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
    const val = asString(rec[key]);
    if (val) return truncateInline(val, 80);
  }
  return undefined;
}

function truncateInline(value: string, maxLen: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen - 1) + "…";
}

function pushUniqueTool(
  events: StreamEvent[],
  state: StreamParserState,
  name: string,
  detail?: string,
  id?: string,
): void {
  const key = id || `${name}:${detail ?? ""}`;
  if (state.seenToolKeys.has(key)) return;
  state.seenToolKeys.add(key);
  events.push({ type: "tool", toolName: name, toolDetail: detail });
}

function pushDeltaOrRemainder(
  events: StreamEvent[],
  state: StreamParserState,
  fullOrDeltaText: string,
  isFullMessage: boolean,
): void {
  if (!fullOrDeltaText) return;

  if (!isFullMessage) {
    state.sawDeltaText = true;
    state.emittedText += fullOrDeltaText;
    events.push({ type: "text", text: fullOrDeltaText });
    return;
  }

  // Full message block: only emit if we haven't already streamed it via deltas
  if (!state.sawDeltaText) {
    if (state.emittedText && fullOrDeltaText.startsWith(state.emittedText)) {
      const remainder = fullOrDeltaText.slice(state.emittedText.length);
      if (remainder) {
        state.emittedText = fullOrDeltaText;
        events.push({ type: "text", text: remainder });
      }
      return;
    }
    if (state.emittedText === fullOrDeltaText) return;
    const prefix = state.emittedText.length > 0 && !state.emittedText.endsWith("\n") ? "\n" : "";
    const chunk = prefix + fullOrDeltaText;
    state.emittedText += chunk;
    events.push({ type: "text", text: chunk });
  }
}

function extractContentBlocks(
  content: unknown,
  events: StreamEvent[],
  state: StreamParserState,
): void {
  if (typeof content === "string") {
    pushDeltaOrRemainder(events, state, content, true);
    return;
  }
  if (!Array.isArray(content)) return;

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    const blockType = asString(block.type);

    if (blockType === "text" || blockType === "output_text") {
      const text = asString(block.text) ?? asString(block.content);
      if (text) pushDeltaOrRemainder(events, state, text, true);
    } else if (blockType === "thinking" || blockType === "reasoning") {
      const thinking = asString(block.thinking) ?? asString(block.text);
      if (thinking && !state.emittedReasoning.includes(thinking)) {
        state.emittedReasoning += thinking;
        events.push({ type: "reasoning", text: thinking });
      }
    } else if (blockType === "tool_use" || blockType === "tool_call" || blockType === "function_call") {
      const name = asString(block.name) ?? asString(asRecord(block.function)?.name) ?? "tool";
      const detail = summarizeToolInput(block.input ?? block.arguments ?? asRecord(block.function)?.arguments);
      const id = asString(block.id) ?? asString(block.call_id);
      pushUniqueTool(events, state, name, detail, id);
    }
  }
}

/**
 * Parses one NDJSON line emitted by Claude Code, Agy, Codex, or Kimi CLIs.
 * If the line is not JSON, falls back gracefully to emitting it as plain text.
 */
export function parseNdjsonLine(
  rawLine: string,
  state: StreamParserState,
  dialect: "claude" | "codex" | "agy" | "kimi" | "generic" = "generic",
): StreamEvent[] {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    if (!state.sawJsonLine && state.emittedText.length > 0) {
      state.emittedText += "\n";
      return [{ type: "text", text: "\n" }];
    }
    return [];
  }

  let parsed: unknown;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
  }

  const obj = asRecord(parsed);
  if (!obj) {
    // Plain text fallback (e.g., CLI running in text mode or printing raw lines)
    const chunk = rawLine + "\n";
    state.emittedText += chunk;
    return [{ type: "text", text: chunk }];
  }

  state.sawJsonLine = true;
  const events: StreamEvent[] = [];

  // Capture session / conversation / thread IDs if present
  const sessionId =
    asString(obj.session_id) ??
    asString(obj.conversation_id) ??
    asString(obj.thread_id) ??
    asString(asRecord(obj.session)?.id);
  if (sessionId) {
    events.push({ type: "session", sessionId });
  }

  const type = asString(obj.type) ?? asString(obj.event) ?? "";

  // 1. Claude / Agy stream_event wrapper (Anthropic Messages stream format)
  if (type === "stream_event") {
    const inner = asRecord(obj.event);
    if (inner) {
      const innerType = asString(inner.type);
      if (innerType === "content_block_delta") {
        const delta = asRecord(inner.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === "text_delta") {
          const text = asString(delta?.text);
          if (text) pushDeltaOrRemainder(events, state, text, false);
        } else if (deltaType === "thinking_delta") {
          const thinking = asString(delta?.thinking);
          if (thinking) {
            state.emittedReasoning += thinking;
            events.push({ type: "reasoning", text: thinking });
          }
        }
      } else if (innerType === "content_block_start") {
        const cb = asRecord(inner.content_block);
        if (asString(cb?.type) === "tool_use") {
          const name = asString(cb?.name) ?? "tool";
          const id = asString(cb?.id);
          pushUniqueTool(events, state, name, undefined, id);
        }
      }
    }
    return events;
  }

  // 2. Direct Anthropic content_block_delta (without stream_event wrapper)
  if (type === "content_block_delta") {
    const delta = asRecord(obj.delta);
    const deltaType = asString(delta?.type);
    if (deltaType === "text_delta" || typeof delta?.text === "string") {
      const text = asString(delta?.text);
      if (text) pushDeltaOrRemainder(events, state, text, false);
    } else if (deltaType === "thinking_delta" || typeof delta?.thinking === "string") {
      const thinking = asString(delta?.thinking);
      if (thinking) {
        state.emittedReasoning += thinking;
        events.push({ type: "reasoning", text: thinking });
      }
    }
    return events;
  }

  // 3. Codex JSONL events (item.started / item.updated / item.completed / response.output_text.delta)
  if (
    dialect === "codex" ||
    type === "item.started" ||
    type === "item.updated" ||
    type === "item.completed"
  ) {
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = asRecord(obj.item);
      if (item) {
        const itemType = asString(item.type) ?? "";
        const itemId = asString(item.id);

        if (itemType === "agent_message" || itemType === "message") {
          const text = asString(item.text);
          if (text) {
            pushDeltaOrRemainder(events, state, text, true);
          } else if (item.content) {
            extractContentBlocks(item.content, events, state);
          }
        } else if (itemType === "reasoning") {
          const text = asString(item.text) ?? asString(item.summary);
          if (text && !state.emittedReasoning.includes(text)) {
            state.emittedReasoning += text;
            events.push({ type: "reasoning", text });
          }
        } else if (itemType === "command_execution") {
          const cmd = asString(item.command);
          pushUniqueTool(events, state, "shell", cmd ? truncateInline(cmd, 80) : undefined, itemId);
        } else if (itemType === "file_change") {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const firstPath = asString(asRecord(changes[0])?.path);
          pushUniqueTool(events, state, "edit", firstPath, itemId);
        } else if (itemType === "mcp_tool_call" || itemType === "tool_call" || itemType === "function_call") {
          const toolName = asString(item.tool) ?? asString(item.name) ?? "tool";
          const detail = summarizeToolInput(item.arguments ?? item.input);
          pushUniqueTool(events, state, toolName, detail, itemId);
        }
      }
      return events;
    }

    if (type === "error" || type === "turn.failed") {
      const msg =
        asString(obj.message) ??
        asString(asRecord(obj.error)?.message) ??
        "Codex execution failed";
      events.push({ type: "error", text: msg });
      return events;
    }
  }

  // 4. Generic delta events (Agy, Kimi, OpenAI Responses, etc.)
  if (
    type === "text_delta" ||
    type === "delta" ||
    type === "content_delta" ||
    type === "response.output_text.delta" ||
    type === "assistant_delta"
  ) {
    const deltaRec = asRecord(obj.delta);
    const text =
      asString(obj.delta) ??
      asString(deltaRec?.text) ??
      asString(deltaRec?.content) ??
      asString(obj.text) ??
      asString(obj.content);
    if (text) pushDeltaOrRemainder(events, state, text, false);

    const reasoning = asString(deltaRec?.reasoning_content) ?? asString(deltaRec?.thinking);
    if (reasoning) {
      state.emittedReasoning += reasoning;
      events.push({ type: "reasoning", text: reasoning });
    }
    return events;
  }

  if (type === "thinking" || type === "reasoning" || type === "thinking_delta") {
    const text = asString(obj.thinking) ?? asString(obj.text) ?? asString(obj.content);
    if (text) {
      state.emittedReasoning += text;
      events.push({ type: "reasoning", text });
    }
    return events;
  }

  if (type === "tool_use" || type === "tool_call" || type === "tool_start") {
    const name = asString(obj.name) ?? asString(obj.tool) ?? asString(asRecord(obj.tool_call)?.name) ?? "tool";
    const detail = summarizeToolInput(obj.input ?? obj.arguments ?? asRecord(obj.tool_call)?.arguments);
    pushUniqueTool(events, state, name, detail, asString(obj.id));
    return events;
  }

  // 5. Full assistant message objects (Claude, Agy, Kimi)
  if (type === "assistant" || type === "message" || asString(obj.role) === "assistant") {
    const message = asRecord(obj.message);
    if (message?.content !== undefined) {
      extractContentBlocks(message.content, events, state);
    } else if (obj.content !== undefined) {
      extractContentBlocks(obj.content, events, state);
    } else if (typeof obj.text === "string") {
      pushDeltaOrRemainder(events, state, obj.text, true);
    }
    // Check OpenAI-style tool_calls array (Kimi / OpenAI format)
    const toolCalls = message?.tool_calls ?? obj.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const rec = asRecord(tc);
        const fn = asRecord(rec?.function);
        const name = asString(fn?.name) ?? asString(rec?.name);
        if (name) {
          pushUniqueTool(
            events,
            state,
            name,
            summarizeToolInput(fn?.arguments ?? rec?.arguments),
            asString(rec?.id),
          );
        }
      }
    }
    return events;
  }

  // 6. Final result object (Claude / Agy / Kimi)
  if (type === "result" || type === "final" || type === "done") {
    const isError = obj.is_error === true;
    const resultText = asString(obj.result) ?? asString(obj.text) ?? asString(obj.output);
    if (isError) {
      events.push({ type: "error", text: resultText || asString(obj.error) || "Agent returned an error" });
    } else if (resultText && !state.emittedText) {
      pushDeltaOrRemainder(events, state, resultText, true);
    }
    events.push({ type: "done" });
    return events;
  }

  if (type === "error") {
    const errText =
      asString(obj.message) ??
      asString(obj.error) ??
      asString(asRecord(obj.error)?.message) ??
      "Unknown agent error";
    events.push({ type: "error", text: errText });
    return events;
  }

  // 7. Fallback for unknown JSON shapes that still carry a top-level text/content delta
  if (type === "text" && typeof obj.text === "string") {
    pushDeltaOrRemainder(events, state, obj.text, false);
  }

  return events;
}

/**
 * Parses one Server-Sent Events (SSE) data line from OpenAI / DeepSeek chat completions.
 */
export function parseOpenAiSseLine(rawLine: string): StreamEvent[] {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("data:")) return [];
  const payload = trimmed.slice(5).trim();
  if (!payload) return [];
  if (payload === "[DONE]") {
    return [{ type: "done" }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  const obj = asRecord(parsed);
  if (!obj) return [];

  const errRec = asRecord(obj.error);
  if (errRec) {
    return [{ type: "error", text: asString(errRec.message) ?? "API error" }];
  }

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = asRecord(choices[0]);
  const delta = asRecord(first?.delta);
  const events: StreamEvent[] = [];

  const reasoning = asString(delta?.reasoning_content);
  if (reasoning) {
    events.push({ type: "reasoning", text: reasoning });
  }

  const content = asString(delta?.content);
  if (content) {
    events.push({ type: "text", text: content });
  }

  return events;
}
