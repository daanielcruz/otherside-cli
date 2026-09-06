import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { buildProvider } from "@/engine/contract/build.ts";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { config } from "../config.ts";
import { translateResponseCodex } from "../stream.ts";
import { translateRequestCodex } from "../translate.ts";
import { clearSessionState } from "../transport/state.ts";

function codexCtx(overrides: Partial<RequestContext>): RequestContext {
  return {
    provider: "codex",
    model: "gpt-5.5",
    sessionId: "session-1",
    cwd: "/workspace/fixture",
    effort: "high",
    permissionMode: "default",
    fastMode: false,
    agentic: false,
    ...overrides,
  } as unknown as RequestContext;
}

function opaquePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = (offset / 4) % 251;
    png.data[offset + 1] = 91;
    png.data[offset + 2] = 173;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function sseStream(events: object[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return (async function* () {
    for (const event of events) yield enc.encode(`data: ${JSON.stringify(event)}\n\n`);
  })();
}

describe("translateRequestCodex reasoning transcript", () => {
  it("keeps effort but omits the reasoning transcript when disableThinking is set", () => {
    const body = translateRequestCodex(codexCtx({ disableThinking: true }), [], []) as Record<
      string,
      unknown
    >;
    const reasoning = body.reasoning as Record<string, unknown> | null;
    expect(reasoning).not.toBeNull();
    expect(reasoning?.effort).toBeDefined();
    // transcript channels suppressed: no summary, no encrypted_content
    expect(reasoning?.summary).toBeUndefined();
    expect(body.include).toEqual([]);
  });

  it("keeps effort + continuity but drops the summary when suppressThinkingSummary is set", () => {
    const body = translateRequestCodex(
      codexCtx({ suppressThinkingSummary: true }),
      [],
      [],
    ) as Record<string, unknown>;
    const reasoning = body.reasoning as Record<string, unknown> | null;
    expect(reasoning).not.toBeNull();
    expect(reasoning?.effort).toBeDefined();
    // summary suppressed, but encrypted_content kept for reasoning continuity
    expect(reasoning?.summary).toBeUndefined();
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  it("returns the reasoning transcript when thinking is allowed", () => {
    const body = translateRequestCodex(codexCtx({ disableThinking: false }), [], []) as Record<
      string,
      unknown
    >;
    const reasoning = body.reasoning as Record<string, unknown>;
    expect(reasoning.effort).toBeDefined();
    expect(reasoning.summary).toBe("auto");
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  it("sends wire max for max and rejects non-catalog levels", () => {
    const maxBody = translateRequestCodex(codexCtx({ effort: "max" }), [], []) as Record<
      string,
      unknown
    >;
    expect((maxBody.reasoning as Record<string, unknown>).effort).toBe("max");

    const unknownBody = translateRequestCodex(
      codexCtx({ effort: "beyond" as never }),
      [],
      [],
    ) as Record<string, unknown>;
    expect(unknownBody.reasoning).toBeNull();
  });

  it("replays transcript input without response-id chaining", () => {
    const body = translateRequestCodex(
      codexCtx({}),
      [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
      [],
    ) as Record<string, unknown>;

    expect(body.store).toBe(false);
    expect(body.previous_response_id).toBeUndefined();
    expect((body.input as unknown[]).length).toBeGreaterThan(1);
  });
});

describe("translateRequestCodex prompt cache key", () => {
  function promptCacheKey(overrides: Partial<RequestContext>): unknown {
    const body = translateRequestCodex(codexCtx(overrides), [], []) as Record<string, unknown>;
    return body.prompt_cache_key;
  }

  it("preserves main, title, and ownerless fork formats", () => {
    expect(promptCacheKey({})).toBe("session-1");
    expect(promptCacheKey({ cacheRole: "title" })).toBe("session-1:title");
    expect(promptCacheKey({ subagentLabel: "collab_spawn" })).toBe("session-1:fork");
  });

  it("uses a distinct key for each owned fork", () => {
    expect(promptCacheKey({ subagentLabel: "collab_spawn", agentOwnerId: "fork-a" })).toBe(
      "session-1:fork:fork-a",
    );
    expect(promptCacheKey({ subagentLabel: "collab_spawn", agentOwnerId: "fork-b" })).toBe(
      "session-1:fork:fork-b",
    );
  });
});

describe("Codex request boundary", () => {
  it("keeps media-free requests byte- and shape-equivalent", () => {
    const ctx = codexCtx({});
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "system" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const direct = translateRequestCodex(ctx, messages, []);
    const throughBoundary = buildProvider(config).translateRequest(ctx, messages, []);

    expect(throughBoundary).toEqual(direct);
    expect(JSON.stringify(throughBoundary)).toBe(JSON.stringify(direct));
  });
});

describe("translateResponseCodex reasoning summary", () => {
  it("strips a placeholder split across streamed deltas", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.reasoning_summary_part.added", item_id: "rs1" },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs1",
        delta: "**Headline**\n<!--",
      },
      { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: " -->" },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    const thinking = out
      .filter((event) => event.kind === "thinking_delta")
      .map((event) => event.text)
      .join("");
    expect(thinking).toBe("**Headline**\n");
    expect(thinking).not.toContain("<!-- -->");
  });

  it("keeps headline and body text in a streamed summary part", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.reasoning_summary_part.added", item_id: "rs1" },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs1",
        delta: "**Headline**\nBody",
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    expect(
      out
        .filter((event) => event.kind === "thinking_delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("**Headline**\nBody");
  });

  it("strips placeholders from the non-streamed reasoning fallback", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs1",
          summary: [
            { type: "summary_text", text: "**Headline**" },
            { type: "summary_text", text: "<!-- -->" },
          ],
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    const thinking = out
      .filter((event) => event.kind === "thinking_delta")
      .map((event) => event.text)
      .join("");
    expect(thinking).toBe("**Headline**\n\n");
    expect(thinking).not.toContain("<!-- -->");
  });
});

describe("codex encrypted_content rejection recovery", () => {
  function reasoningMessages(): Message[] {
    return [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        producedModel: "gpt-5.5",
        producedAccount: accountFingerprint("codex"),
        content: [
          { type: "thinking", text: "prior reasoning", signature: "Ep8I-STALE-BLOB-AQ==" },
          { type: "text", text: "done" },
        ],
      },
    ];
  }

  function verificationError() {
    return streamErrorToHttpError({
      provider: "codex/responses",
      rawBody: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message:
            "The encrypted content Ep8I...AQ== could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
        },
      }),
    });
  }

  it("replays encrypted_content until rejected, then drops it and retries once", () => {
    const sessionId = "codex-enc-reject";
    clearSessionState(sessionId);
    const ctx = codexCtx({ sessionId });
    const msgs = reasoningMessages();

    const before = translateRequestCodex(ctx, msgs, []) as Record<string, unknown>;
    const reasoningBefore = (before.input as Array<Record<string, unknown>>).find(
      (i) => i.type === "reasoning",
    );
    expect(reasoningBefore?.encrypted_content).toBe("Ep8I-STALE-BLOB-AQ==");

    const first = config.recoverableError?.(verificationError(), ctx, 1);
    expect(first?.kind).toBe("retry");

    const after = translateRequestCodex(ctx, msgs, []) as Record<string, unknown>;
    const reasoningAfter = (after.input as Array<Record<string, unknown>>).find(
      (i) => i.type === "reasoning",
    );
    expect(reasoningAfter).toBeUndefined();

    // A still-failing turn does not retry forever: the second identical error
    // is no longer eligible for the drop-and-retry path.
    const second = config.recoverableError?.(verificationError(), ctx, 2);
    expect(second?.kind).not.toBe("retry");
  });
});

describe("translateResponseCodex stream edge scenarios", () => {
  it("response.failed with error code insufficient_quota and no type throws 429", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.failed",
        response: {
          error: {
            code: "insufficient_quota",
            message: "Quota exceeded",
          },
        },
      },
    ];

    let thrown: unknown = null;
    try {
      for await (const _ of translateResponseCodex(sseStream(events)));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect((thrown as { status: number }).status).toBe(429);
    expect((thrown as { quotaExhausted: boolean }).quotaExhausted).toBe(true);
  });

  it("response.failed with error code context_length_exceeded throws 400", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.failed",
        response: {
          error: {
            code: "context_length_exceeded",
            message: "Context length exceeded",
          },
        },
      },
    ];

    let thrown: unknown = null;
    try {
      for await (const _ of translateResponseCodex(sseStream(events)));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect((thrown as { status: number }).status).toBe(400);
  });

  it("response.incomplete yields usage then throws retryable 500 error", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.incomplete",
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
          },
          incomplete_details: {
            reason: "max_output_tokens",
          },
        },
      },
    ];

    const out: ProviderEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const event of translateResponseCodex(sseStream(events))) {
        out.push(event);
      }
    } catch (err) {
      thrown = err;
    }

    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ kind: "message_start" });
    expect(out[1]!.kind).toBe("usage");
    expect((out[1] as Extract<ProviderEvent, { kind: "usage" }>).inputTokens).toBe(10);
    expect((out[1] as Extract<ProviderEvent, { kind: "usage" }>).outputTokens).toBe(20);

    expect(thrown).not.toBeNull();
    expect((thrown as { status: number }).status).toBe(500);
    expect((thrown as Error).message).toContain("incomplete response");
    expect((thrown as Error).message).toContain("max_output_tokens");
  });

  it("recovers a terminal function call missing only its final closer", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: {
          id: "item-1",
          call_id: "call-1",
          type: "function_call",
          name: "my_tool",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        delta: '{"command":"printf ok"',
      },
      {
        type: "response.output_item.done",
        item: {
          id: "item-1",
          call_id: "call-1",
          type: "function_call",
          name: "my_tool",
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) {
      out.push(event);
    }

    const toolCallStart = out.find((e) => e.kind === "tool_call_start");
    const toolCallComplete = out.find((e) => e.kind === "tool_call_complete");

    expect(toolCallStart).toEqual({ kind: "tool_call_start", id: "call-1", name: "my_tool" });
    expect(toolCallComplete).toEqual({
      kind: "tool_call_complete",
      id: "call-1",
      name: "my_tool",
      input: { command: "printf ok" },
    });
  });

  it("recovers item.arguments when the delta buffer is empty", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: {
          id: "item-2",
          call_id: "call-2",
          type: "function_call",
          name: "my_tool",
        },
      },
      {
        type: "response.output_item.done",
        item: {
          id: "item-2",
          call_id: "call-2",
          type: "function_call",
          name: "my_tool",
          arguments: '{"command":"printf ok"',
        },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    expect(out.find((event) => event.kind === "tool_call_complete")).toEqual({
      kind: "tool_call_complete",
      id: "call-2",
      name: "my_tool",
      input: { command: "printf ok" },
    });
  });

  it("stops cleanly after a hosted web search", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: {
          type: "web_search_call",
          id: "ws_1",
          action: { type: "search", query: "top story hacker news" },
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "web_search_call",
          id: "ws_1",
          action: { type: "search", query: "top story hacker news" },
        },
      },
      { type: "response.output_text.delta", item_id: "m1", delta: "The top story is..." },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    expect(out.find((event) => event.kind === "tool_call_complete")).toMatchObject({
      kind: "tool_call_complete",
      id: "ws_1",
      name: "WebSearch",
      serverHandled: true,
      input: { query: "top story hacker news" },
    });
    expect(out.find((event) => event.kind === "message_stop")).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });
  });

  it("reports tool_calls when a function call follows a hosted web search", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "docs" } },
      },
      {
        type: "response.output_item.done",
        item: { type: "web_search_call", id: "ws_1", action: { type: "search", query: "docs" } },
      },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc1", call_id: "call_1", name: "Read" },
      },
      {
        type: "response.output_item.done",
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
    for await (const event of translateResponseCodex(sseStream(events))) out.push(event);

    expect(out.find((event) => event.kind === "message_stop")).toEqual({
      kind: "message_stop",
      stop_reason: "tool_calls",
    });
  });
});

describe("translateRequestCodex images", () => {
  it("marks direct user images with high detail", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          },
        ],
      },
    ];
    const body = translateRequestCodex(codexCtx({}), messages, []) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const message = input.find((item) => item.type === "message");

    expect(message?.content).toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
        detail: "high",
      },
    ]);
  });

  it("encodes tool_result image blocks as function_call_output content items", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read the image" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_img", name: "Read", input: { file_path: "/tmp/x.png" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_img",
            content: [
              { type: "text", text: "Read image (12KB)" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      },
    ];
    const body = translateRequestCodex(codexCtx({}), messages, []) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const output = input.find((i) => i.type === "function_call_output");
    expect(output).toBeDefined();
    const items = output?.output as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items[0]).toEqual({ type: "input_text", text: "Read image (12KB)" });
    expect(items[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,aGVsbG8=",
      detail: "high",
    });
  });

  it("forces high detail on serialized input_image tool output", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_serialized_image",
            content: JSON.stringify([
              {
                type: "input_image",
                image_url: "data:image/png;base64,aGVsbG8=",
                detail: "auto",
              },
            ]),
          },
        ],
      },
    ];
    const body = translateRequestCodex(codexCtx({}), messages, []) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const output = input.find((item) => item.type === "function_call_output");

    expect(output?.output).toEqual([
      {
        type: "input_image",
        image_url: "data:image/png;base64,aGVsbG8=",
        detail: "high",
      },
    ]);
  });

  it("applies the active route policy to serialized input_image tool output", () => {
    const original = opaquePng(2500, 1200).toString("base64");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_serialized_oversize",
            content: JSON.stringify([
              {
                type: "input_image",
                image_url: `data:image/png;base64,${original}`,
                detail: "auto",
              },
            ]),
          },
        ],
      },
    ];
    const body = buildProvider(config).translateRequest(codexCtx({}), messages, []) as {
      input: Array<Record<string, unknown>>;
    };
    const output = body.input.find((item) => item.type === "function_call_output")?.output as Array<
      Record<string, unknown>
    >;
    const imageUrl = output[0]?.image_url;
    if (typeof imageUrl !== "string") throw new Error("serialized image missing");
    const encoded = imageUrl.slice(imageUrl.indexOf(",") + 1);
    const prepared = PNG.sync.read(Buffer.from(encoded, "base64"));

    expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(2048);
    expect(prepared.width * prepared.height).toBeLessThanOrEqual(2_560_000);
    expect(Buffer.from(encoded, "base64").length).toBeLessThanOrEqual(786_432);
    expect(output[0]?.detail).toBe("high");
    expect(JSON.stringify(messages)).toContain(original);
  });

  it("encodes tool_result PDF blocks as input_file content items", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_pdf", name: "Read", input: { file_path: "/tmp/x.pdf" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_pdf",
            content: [
              { type: "text", text: "Read PDF" },
              {
                type: "pdf",
                source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
                filename: "x.pdf",
                pageCount: 1,
                bytes: 3,
              },
            ],
          },
        ],
      },
    ];
    const body = translateRequestCodex(codexCtx({}), messages, []) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const output = input.find((item) => item.type === "function_call_output");
    expect(output?.output).toEqual([
      { type: "input_text", text: "Read PDF" },
      { type: "input_file", filename: "x.pdf", file_data: "data:application/pdf;base64,cGRm" },
    ]);
  });
});

describe("translateRequestCodex Lite model formatting & enhancements", () => {
  it("Lite model request has developer-item instructions+tools, no top-level tools, parallel_tool_calls=false, reasoning.context='all_turns'", () => {
    const ctx = codexCtx({ model: "gpt-5.6-sol" });
    const msgs: Message[] = [
      { role: "system", content: [{ type: "text", text: "sys instructions" }] },
      { role: "user", content: [{ type: "text", text: "user message" }] },
    ];
    const tools = [
      {
        name: "test_tool",
        description: "a test tool",
        input_schema: { type: "object", properties: { x: { type: "number" } } },
      },
      {
        name: "WebSearch",
        description: "search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ];

    const request = translateRequestCodex(ctx, msgs, tools) as Record<string, unknown>;

    // (1) instructions and tool schemas move into developer input items
    expect(request.instructions).toBeUndefined();
    expect(request.tools).toBeUndefined();

    const input = request.input as Array<Record<string, unknown>>;
    const toolItem = input.find((item) => item.type === "additional_tools");
    expect(toolItem).toBeDefined();
    expect(toolItem?.role).toBe("developer");
    expect(toolItem?.tools).toEqual([
      {
        type: "function",
        name: "test_tool",
        description: "a test tool",
        strict: false,
        parameters: { type: "object", properties: { x: { type: "number" } } },
      },
      {
        type: "function",
        name: "WebSearch",
        description: "search the web",
        strict: false,
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);

    const msgItem = input.find((item) => item.type === "message" && item.role === "developer");
    expect(msgItem).toBeDefined();
    expect(msgItem?.content).toContainEqual({
      type: "input_text",
      text: expect.stringContaining("sys instructions"),
    });

    // (2) parallel_tool_calls = false
    expect(request.parallel_tool_calls).toBe(false);

    // (3) reasoning context = all_turns
    const reasoning = request.reasoning as Record<string, unknown> | null;
    expect(reasoning?.context).toBe("all_turns");
  });

  it("Lite models replay WebSearch calls and results instead of dropping them", () => {
    const ctx = codexCtx({ model: "gpt-5.6-sol" });
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "find docs" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ws-1", name: "WebSearch", input: { query: "codex docs" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "ws-1",
            content: '{"query":"codex docs","results":["Codex docs — https://example.com"]}',
          },
        ],
      },
    ];

    const request = translateRequestCodex(ctx, msgs, []) as Record<string, unknown>;
    const input = request.input as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call");
    const output = input.find((item) => item.type === "function_call_output");

    expect(call?.name).toBe("WebSearch");
    expect(String(output?.output ?? "")).toContain("Codex docs — https://example.com");
  });

  it("gpt-5.5 still drops WebSearch history in hosted mode", () => {
    const ctx = codexCtx({ model: "gpt-5.5" });
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ws-1", name: "WebSearch", input: { query: "codex docs" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "ws-1", content: "hosted echo" }],
      },
    ];

    const request = translateRequestCodex(ctx, msgs, []) as Record<string, unknown>;
    const input = request.input as Array<Record<string, unknown>>;

    expect(input.find((item) => item.type === "function_call")).toBeUndefined();
    expect(input.find((item) => item.type === "function_call_output")).toBeUndefined();
  });

  it("gpt-5.5 request is unchanged from classic shape", () => {
    const ctx = codexCtx({ model: "gpt-5.5" });
    const msgs: Message[] = [
      { role: "system", content: [{ type: "text", text: "sys instructions" }] },
      { role: "user", content: [{ type: "text", text: "user message" }] },
    ];
    const tools = [
      {
        name: "test_tool",
        description: "a test tool",
        input_schema: { type: "object", properties: { x: { type: "number" } } },
      },
      {
        name: "WebSearch",
        description: "search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ];

    const request = translateRequestCodex(ctx, msgs, tools) as Record<string, unknown>;

    expect(request.instructions as string).toContain("sys instructions");
    expect(request.tools).toBeDefined();
    expect(request.parallel_tool_calls).toBe(true);
    const reasoning = request.reasoning as Record<string, unknown> | null;
    expect(reasoning?.context).toBeUndefined();

    // Verify tools has the test_tool and the web_search fallback tool
    const requestTools = request.tools as unknown[];
    expect(requestTools).toContainEqual({
      type: "function",
      name: "test_tool",
      description: "a test tool",
      strict: false,
      parameters: { type: "object", properties: { x: { type: "number" } } },
    });
    expect(requestTools).toContainEqual({
      type: "web_search",
      external_web_access: true,
      search_content_types: ["text", "image"],
    });
    expect(requestTools).not.toContainEqual(
      expect.objectContaining({
        type: "function",
        name: "WebSearch",
      }),
    );
  });

  it("fast mode on a model without priority tier omits service_tier, and emits it on one that has it", () => {
    // Model "gpt-5.3-codex-spark" does not have priority service tier (serviceTiers: [])
    const ctxNoPriority = codexCtx({ model: "gpt-5.3-codex-spark", fastMode: true });
    const reqNoPriority = translateRequestCodex(ctxNoPriority, [], []) as Record<string, unknown>;
    expect(reqNoPriority.service_tier).toBeUndefined();

    // Model "gpt-5.5" has priority service tier (serviceTiers: ["priority"])
    const ctxWithPriority = codexCtx({ model: "gpt-5.5", fastMode: true });
    const reqWithPriority = translateRequestCodex(ctxWithPriority, [], []) as Record<
      string,
      unknown
    >;
    expect(reqWithPriority.service_tier).toBe("priority");
  });

  it("reasoning item replayed across codex model switch, still dropped on account mismatch", () => {
    // Replayed across model switch: e.g. producedModel = "gpt-5.5", currentModel = "gpt-5.6-sol"
    const currentAccount = accountFingerprint("codex");
    const msgs: Message[] = [
      {
        role: "assistant",
        producedModel: "gpt-5.5",
        producedBy: "codex",
        producedAccount: currentAccount,
        content: [{ type: "thinking", text: "prior reasoning", signature: "signature-123" }],
      },
    ];

    // Case 1: same account, different model -> should be replayed (since both are codex)
    const ctx = codexCtx({ model: "gpt-5.6-sol" });
    const request1 = translateRequestCodex(ctx, msgs, []) as Record<string, unknown>;
    const input1 = request1.input as Array<Record<string, unknown>>;
    const reasoning1 = input1.find((item) => item.type === "reasoning");
    expect(reasoning1).toBeDefined();
    expect(reasoning1?.encrypted_content).toBe("signature-123");

    // Case 2: account mismatch -> should be dropped
    const request2 = translateRequestCodex(
      ctx,
      msgs,
      [],
      // Extra or context with a different account fingerprint (e.g. from context/mocking)
      // Actually account identity uses standard sameAccountFingerprint comparing producedAccount and currentAccount.
      // Let's pass a different currentAccount to translateRequestCodex by override or mocking.
    );
    // Let's check how sameAccountFingerprint is implemented or what currentAccount is in translateRequestCodex:
    // in translateRequestCodex, accountFingerprint(ctx.provider) is passed.
    // Since ctx.provider is "codex" here, the currentAccount is always accountFingerprint("codex").
    // We can simulate an account mismatch by setting msgs.producedAccount to "other-account".
    const msgsAccountMismatch: Message[] = [
      {
        role: "assistant",
        producedModel: "gpt-5.5",
        producedBy: "codex",
        producedAccount: "other-account",
        content: [{ type: "thinking", text: "prior reasoning", signature: "signature-123" }],
      },
    ];
    const request3 = translateRequestCodex(ctx, msgsAccountMismatch, []) as Record<string, unknown>;
    const input3 = request3.input as Array<Record<string, unknown>>;
    const reasoning3 = input3.find((item) => item.type === "reasoning");
    expect(reasoning3).toBeUndefined();
  });
});
