import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  clampSummaryRequest,
  dropImageBlocksFromMessages,
  summarizeConversation,
} from "../compact/summary.ts";

type StreamOutcome = Error | ProviderEvent[];

const TEST_PROVIDER = "summary-retry-test" as RequestContext["provider"];
const SUCCESS_EVENTS: ProviderEvent[] = [
  { kind: "text_delta", text: "A useful compacted summary." },
  { kind: "message_stop", stop_reason: "stop" },
];

let outcomes: StreamOutcome[] = [];
let translateFailures: Error[] = [];
let streamCalls = 0;
let onStream: ((index: number) => void) | undefined;
let sentHistories: Message[][] = [];

const fakeProvider = {
  id: TEST_PROVIDER,
  label: "Summary Retry Test",
  shortKey: "summary-retry-test",
  composeMessages: (_harness: unknown, history: Message[]) => history,
  translateRequest: (_ctx: RequestContext, history: Message[]) => {
    sentHistories.push(history);
    const failure = translateFailures.shift();
    if (failure) throw failure;
    return { model: "summary-retry-model" };
  },
  startStreamAttempt: () => {
    const index = streamCalls;
    streamCalls += 1;
    onStream?.(index);
    const outcome = outcomes[index];
    return {
      events: (async function* () {
        if (outcome instanceof Error) throw outcome;
        if (outcome !== undefined) yield* outcome;
      })(),
      abort: () => {},
    };
  },
  recoverableError: (err: unknown) => ({
    kind: "fail",
    reason: err instanceof Error ? err.message : String(err),
  }),
} as unknown as Provider;

function ctx(signal?: AbortSignal): RequestContext {
  return {
    provider: TEST_PROVIDER,
    model: "summary-retry-model",
    effort: null,
    permissionMode: "default",
    sessionId: "summary-retry-session",
    cwd: mkdtempSync(join(tmpdir(), "summary-retry-test-")),
    ...(signal ? { abortSignal: signal } : {}),
  };
}

function messages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Please summarize this conversation." }] },
  ];
}

describe("clampSummaryRequest", () => {
  it("preserves opaque transport identity when no output cap is present", () => {
    class SessionRequest {
      readonly model = "fixture-model";
    }
    const request = new SessionRequest();
    const bindings = new WeakMap<object, string>([[request, "fixture-session"]]);
    const clamped = clampSummaryRequest(request);
    expect(clamped).toBe(request);
    expect(clamped).toBeInstanceOf(SessionRequest);
    expect(bindings.get(clamped as SessionRequest)).toBe("fixture-session");
  });

  it("preserves a request already within the output cap", () => {
    const request = { max_tokens: 16_000 };
    expect(clampSummaryRequest(request)).toBe(request);
  });

  it("caps oversized output without mutating the request or thinking settings", () => {
    const request = { max_tokens: 128_000, thinking: { type: "adaptive" } };
    expect(clampSummaryRequest(request)).toEqual({
      max_tokens: 32_000,
      thinking: request.thinking,
    });
    expect(request.max_tokens).toBe(128_000);
  });
});

describe("summarizeConversation retry", () => {
  beforeEach(() => {
    outcomes = [];
    translateFailures = [];
    streamCalls = 0;
    onStream = undefined;
    sentHistories = [];
    providers.register(fakeProvider);
  });

  it("sends no image to the summary request, including screenshots read by a tool", async () => {
    outcomes = [SUCCESS_EVENTS];
    const screenshot = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" },
    };
    await summarizeConversation(
      ctx(),
      [
        { role: "user", content: [{ type: "text", text: "Check the page." }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "s1.png" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "read-1", content: [screenshot] }],
        },
      ],
      [],
    );
    const sent = JSON.stringify(sentHistories);
    expect(sentHistories.length).toBeGreaterThan(0);
    expect(sent).not.toContain('"type":"image"');
    expect(sent).toContain("[image]");
  });

  it("retries once after a failed summary stream and returns the second success", async () => {
    outcomes = [[{ kind: "error", error: "temporary summary failure" }], SUCCESS_EVENTS];

    const result = await summarizeConversation(ctx(), messages(), []);

    expect(result.summary).toBe("A useful compacted summary.");
    expect(streamCalls).toBe(2);
  });

  it("propagates the second failure without changing its failure shape", async () => {
    translateFailures = [
      new TypeError("first translate failure"),
      new TypeError("second translate failure"),
    ];

    const err = await summarizeConversation(ctx(), messages(), []).catch((caught) => caught);

    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe("second translate failure");
    expect(streamCalls).toBe(0);
  });

  it("does not retry after cancellation aborts the first attempt", async () => {
    const controller = new AbortController();
    outcomes = [new Error("aborted"), SUCCESS_EVENTS];
    onStream = (index) => {
      if (index === 0) controller.abort();
    };

    const err = await summarizeConversation(ctx(controller.signal), messages(), []).catch(
      (caught) => caught,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("aborted");
    expect(streamCalls).toBe(1);
  });
});

describe("dropImageBlocksFromMessages", () => {
  const image = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" },
  };

  it("replaces images inside tool results as well as loose ones", () => {
    const dropped = dropImageBlocksFromMessages([
      { role: "user", content: [image, { type: "text", text: "look" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: [{ type: "text", text: "screenshot" }, image],
          },
        ],
      },
    ]);
    expect(JSON.stringify(dropped)).not.toContain('"type":"image"');
    expect(dropped[0]?.content[0]).toEqual({ type: "text", text: "[image]" });
    expect(dropped[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "read-1",
      content: [
        { type: "text", text: "screenshot" },
        { type: "text", text: "[image]" },
      ],
    });
  });

  it("returns a message without images unchanged", () => {
    const message: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(dropImageBlocksFromMessages([message])[0]).toBe(message);
  });
});
