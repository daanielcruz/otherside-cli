import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { summarizeConversation } from "../compact/summary.ts";

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

const fakeProvider = {
  id: TEST_PROVIDER,
  label: "Summary Retry Test",
  shortKey: "summary-retry-test",
  composeMessages: (_harness: unknown, history: Message[]) => history,
  translateRequest: () => {
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

describe("summarizeConversation retry", () => {
  beforeEach(() => {
    outcomes = [];
    translateFailures = [];
    streamCalls = 0;
    onStream = undefined;
    providers.register(fakeProvider);
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
