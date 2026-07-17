import { describe, expect, test } from "bun:test";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import { translateRequestGrok, translateResponseGrok } from "@/engine/providers/xai/translate.ts";
import type { SessionRecord } from "@/engine/session/record/schema.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(over: Partial<RequestContext>): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "default",
    sessionId: "s1",
    cwd: "/tmp",
    ...over,
  } as RequestContext;
}

function sseStream(events: object[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return (async function* () {
    for (const e of events) yield enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  })();
}

describe("translateRequestGrok", () => {
  test("builds the CLI chat proxy Responses body with captured shape", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "You are Grok." }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call_1", name: "Read", input: { path: "/a" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }],
      },
    ];
    const tools = [
      {
        name: "Read",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const body = translateRequestGrok(ctx({}), messages, tools) as Record<string, unknown>;

    expect(body.model).toBe("grok-4.5");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ summary: "concise", effort: "high" });
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "Read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        description: "read a file",
      },
      { type: "web_search" },
    ]);
    expect(body.input).toEqual([
      { type: "message", role: "system", content: "You are Grok." },
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "calling tool" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "Read",
        arguments: JSON.stringify({ path: "/a" }),
        status: "completed",
      },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  test("replays PDF tool results as a placeholder without rewriting session history", () => {
    const pdf = {
      type: "pdf" as const,
      source: { type: "base64" as const, media_type: "application/pdf" as const, data: "cGRm" },
      filename: "report.pdf",
      pageCount: 1,
      bytes: 3,
    };
    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-07-16T00:00:00.000Z",
        call_id: "pdf",
        tool_name: "Read",
        args: { file_path: "/tmp/report.pdf" },
      },
      {
        type: "tool_result",
        ts: "2026-07-16T00:00:01.000Z",
        call_id: "pdf",
        result: [pdf],
        is_error: false,
      },
    ];
    const sessionMessages = sessionRecordsToMessages(records);

    const xaiBody = translateRequestGrok(ctx({}), sessionMessages, []) as {
      input: Array<Record<string, unknown>>;
    };
    expect(xaiBody.input).toEqual([
      {
        type: "function_call",
        call_id: "pdf",
        name: "Read",
        arguments: JSON.stringify({ file_path: "/tmp/report.pdf" }),
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "pdf",
        output:
          "[PDF content is unavailable on this provider. Re-read the file to provide page images.]",
      },
    ]);
    expect(JSON.stringify(xaiBody)).not.toContain("cGRm");

    const storedResult = records.find(
      (record): record is Extract<SessionRecord, { type: "tool_result" }> =>
        record.type === "tool_result",
    );
    expect(storedResult?.result).toEqual([pdf]);
    const rebuiltResult = sessionMessages[1]!.content[0];
    expect(rebuiltResult).toEqual({ type: "tool_result", tool_use_id: "pdf", content: [pdf] });

    const anthropic = buildAnthropicMessages(sessionMessages, {
      provider: "anthropic",
      model: "claude-opus-4-8",
    } as RequestContext);
    expect(anthropic.out[1]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "pdf",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          },
        ],
      },
    ]);
  });

  test("maps a user image turn to an input_image content array", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ];
    const body = translateRequestGrok(ctx({}), messages, []) as { input: unknown[] };
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      },
    ]);
  });

  test("always sends reasoning.summary; effort only when set and folded to high", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const reasoningOf = (over: Partial<RequestContext>) =>
      (translateRequestGrok(ctx(over), messages, []) as Record<string, unknown>).reasoning;
    expect(reasoningOf({ effort: null })).toEqual({ summary: "concise" });
    // disableThinking cannot send effort "none" (proxy 400s it on grok-4.5) —
    // it folds to the model's cheapest real effort with no summary/include.
    expect(reasoningOf({ disableThinking: true })).toEqual({ effort: "low" });
    const off = translateRequestGrok(ctx({ disableThinking: true }), messages, []) as Record<
      string,
      unknown
    >;
    expect(off.include).toBeUndefined();
    expect(reasoningOf({ effort: "low" })).toEqual({ summary: "concise", effort: "low" });
    expect(reasoningOf({ effort: "xhigh" })).toEqual({ summary: "concise", effort: "high" });
    expect(reasoningOf({ effort: "max" })).toEqual({ summary: "concise", effort: "high" });
    // no tools declared -> no tools / tool_choice fields
    const bare = translateRequestGrok(ctx({}), messages, []) as Record<string, unknown>;
    expect(bare.tools).toBeUndefined();
    expect(bare.tool_choice).toBeUndefined();
  });

  test("does not replay prior encrypted reasoning when thinking is disabled", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        producedModel: "grok-4.5",
        content: [
          { type: "thinking", thinking: "earlier", text: "earlier", signature: "ENC_PRIOR" },
          { type: "text", text: "hi" },
        ],
      } as Message,
      { role: "user", content: [{ type: "text", text: "again" }] },
    ];
    const body = translateRequestGrok(ctx({ disableThinking: true }), messages, []) as {
      input: Array<Record<string, unknown>>;
      include?: unknown;
      reasoning?: unknown;
    };
    expect(body.input.some((i) => i.type === "reasoning")).toBe(false);
    expect(body.include).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  test("injects one hosted web_search tool and drops both client aliases", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const tools = [
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "WebSearch", input_schema: { type: "object", properties: { query: {} } } },
      { name: "web_search", input_schema: { type: "object", properties: { query: {} } } },
    ];
    const body = translateRequestGrok(ctx({}), messages, tools) as Record<string, unknown>;
    expect(body.tools).toEqual([
      { type: "function", name: "Read", parameters: { type: "object", properties: {} } },
      { type: "web_search" },
    ]);
  });

  test("drops server-handled WebSearch calls and results from replayed history", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "find docs" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ws-1", name: "WebSearch", input: { query: "grok docs" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "ws-1", content: "grok docs — https://x.ai" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    const body = translateRequestGrok(ctx({}), messages, [
      { name: "Read", input_schema: { type: "object", properties: {} } },
    ]) as { input: Array<Record<string, unknown>> };
    expect(body.input.some((i) => i.type === "function_call")).toBe(false);
    expect(body.input.some((i) => i.type === "function_call_output")).toBe(false);
  });

  test("omits reasoning and include for a non-reasoning model (composer)", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const body = translateRequestGrok(
      ctx({ model: "grok-composer-2.5-fast", disableThinking: true }),
      messages,
      [],
    ) as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.model).toBe("grok-composer-2.5-fast");
  });
});

describe("translateResponseGrok", () => {
  test("maps the Responses SSE stream to provider events", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "thinking..." },
      { type: "response.output_text.delta", item_id: "m1", delta: "Hello" },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc1", call_id: "call_9", name: "Read" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc1",
        output_index: 0,
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc1",
        output_index: 0,
        delta: '"/a"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc1",
          call_id: "call_9",
          name: "Read",
          arguments: '{"path":"/a"}',
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "reasoning", id: "rs1", summary: [], encrypted_content: "ENC123" },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ];

    const out: ProviderEvent[] = [];
    for await (const ev of translateResponseGrok(sseStream(events))) out.push(ev);

    expect(out.map((e) => e.kind)).toContain("message_start");
    expect(out.find((e) => e.kind === "thinking_delta")).toEqual({
      kind: "thinking_delta",
      text: "thinking...",
    });
    expect(out.find((e) => e.kind === "text_delta")).toEqual({ kind: "text_delta", text: "Hello" });
    expect(out.find((e) => e.kind === "tool_call_start")).toEqual({
      kind: "tool_call_start",
      id: "call_9",
      name: "Read",
    });
    expect(out.find((e) => e.kind === "tool_call_complete")).toEqual({
      kind: "tool_call_complete",
      id: "call_9",
      name: "Read",
      input: { path: "/a" },
    });
    expect(out.find((e) => e.kind === "thinking_signature")).toEqual({
      kind: "thinking_signature",
      signature: "ENC123",
    });
    expect(out.find((e) => e.kind === "usage")).toMatchObject({
      kind: "usage",
      outputTokens: 5,
      thoughtTokens: 2,
    });
    expect(out.find((e) => e.kind === "message_stop")).toEqual({
      kind: "message_stop",
      stop_reason: "tool_calls",
    });
  });

  test("recovers a terminal function call missing only its final closer", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc2", call_id: "call_2", name: "Bash" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc2",
        delta: '{"command":"printf ok"',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc2", call_id: "call_2", name: "Bash" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseGrok(sseStream(events))) out.push(event);

    expect(out.find((event) => event.kind === "tool_call_complete")).toEqual({
      kind: "tool_call_complete",
      id: "call_2",
      name: "Bash",
      input: { command: "printf ok" },
    });
  });

  test("maps hosted web_search_call items to a server-handled WebSearch tool call", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "in_progress",
          action: { type: "search", query: "top story hacker news", sources: [] },
        },
      },
      { type: "response.web_search_call.searching", item_id: "ws_1" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "top story hacker news" },
        },
      },
      { type: "response.output_text.delta", item_id: "m1", delta: "The top story is..." },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const ev of translateResponseGrok(sseStream(events))) out.push(ev);

    expect(out.find((e) => e.kind === "tool_call_start")).toEqual({
      kind: "tool_call_start",
      id: "ws_1",
      name: "WebSearch",
    });
    const complete = out.find((e) => e.kind === "tool_call_complete");
    expect(complete).toMatchObject({
      kind: "tool_call_complete",
      id: "ws_1",
      name: "WebSearch",
      serverHandled: true,
    });
    expect((complete as { input: Record<string, unknown> }).input.query).toBe(
      "top story hacker news",
    );
    // Server-handled search is resolved inline and the model answers in the same
    // turn, so a search-only turn must stop cleanly rather than loop for tools.
    expect(out.find((e) => e.kind === "message_stop")).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
  });

  test("still reports tool_calls when a real function call follows a web search", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "docs" } },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "docs" } },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc1", call_id: "call_1", name: "Read" },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc1",
          call_id: "call_1",
          name: "Read",
          arguments: "{}",
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const ev of translateResponseGrok(sseStream(events))) out.push(ev);

    expect(out.find((e) => e.kind === "message_stop")).toEqual({
      kind: "message_stop",
      stop_reason: "tool_calls",
    });
  });

  test("throws when the stream closes before a terminal event", async () => {
    const stream = sseStream([{ type: "response.created", response: { id: "r1" } }]);
    await expect(
      (async () => {
        for await (const _ of translateResponseGrok(stream)) {
          // drain
        }
      })(),
    ).rejects.toThrow();
  });
});
