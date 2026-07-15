import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import {
  getContentIdleTimeoutMs,
  isContentProgressEvent,
  wrapProviderEventsWithContentIdleTimeout,
} from "../content-idle-timeout.ts";
import { StreamIdleTimeoutError } from "../idle-timeout.ts";

const ENV_KEY = "OTHERSIDE_CONTENT_IDLE_TIMEOUT_MS";

describe("getContentIdleTimeoutMs", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("defaults to 180s", () => {
    delete process.env[ENV_KEY];
    expect(getContentIdleTimeoutMs()).toBe(180_000);
  });

  test("env override wins", () => {
    process.env[ENV_KEY] = "45000";
    expect(getContentIdleTimeoutMs()).toBe(45_000);
  });

  test("invalid or non-positive env falls back to the default", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(getContentIdleTimeoutMs()).toBe(180_000);
    process.env[ENV_KEY] = "0";
    expect(getContentIdleTimeoutMs()).toBe(180_000);
  });

  test("no env, no provider default -> 180s", () => {
    delete process.env[ENV_KEY];
    expect(getContentIdleTimeoutMs()).toBe(180_000);
  });

  test("no env, providerDefaultMs 600s -> 600s", () => {
    delete process.env[ENV_KEY];
    expect(getContentIdleTimeoutMs(600_000)).toBe(600_000);
  });

  test("env set wins over providerDefaultMs", () => {
    const previous = process.env[ENV_KEY];
    try {
      process.env[ENV_KEY] = "45000";
      expect(getContentIdleTimeoutMs(600_000)).toBe(45_000);
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    }
  });

  test("non-positive or NaN providerDefaultMs falls back to the default", () => {
    delete process.env[ENV_KEY];
    expect(getContentIdleTimeoutMs(0)).toBe(180_000);
    expect(getContentIdleTimeoutMs(-1)).toBe(180_000);
    expect(getContentIdleTimeoutMs(Number.NaN)).toBe(180_000);
  });
});

describe("isContentProgressEvent", () => {
  test("counts text/thinking/tool/message/usage events as progress", () => {
    const progressEvents: ProviderEvent[] = [
      { kind: "message_start" },
      { kind: "usage" },
      { kind: "usage_limits", provider: "codex", usage: {} },
      { kind: "text_delta", text: "hi" },
      { kind: "thinking_delta", text: "hmm" },
      { kind: "thinking_signature", signature: "sig" },
      { kind: "tool_call_start", id: "1", name: "read" },
      { kind: "tool_call_input_delta", id: "1", partial: "{}" },
      { kind: "tool_call_complete", id: "1", name: "read", input: {} },
      { kind: "message_stop", stop_reason: "end_turn" },
    ];
    for (const ev of progressEvents) expect(isContentProgressEvent(ev)).toBe(true);
  });

  test("does not count retry/error control events as progress", () => {
    const controlEvents: ProviderEvent[] = [
      { kind: "retry_status", attempt: 1, maxAttempts: 10, delayMs: 0, reason: "x" },
      { kind: "stream_reset", reason: "x", attempt: 1 },
      { kind: "error", error: "boom" },
      { kind: "quota_exhausted", provider: "p", model: "m", resetEpochMs: null, message: "x" },
    ];
    for (const ev of controlEvents) expect(isContentProgressEvent(ev)).toBe(false);
  });
});

async function* delayedEvents(
  items: { ev: ProviderEvent; delayMs: number }[],
): AsyncIterable<ProviderEvent> {
  for (const item of items) {
    await new Promise((resolve) => setTimeout(resolve, item.delayMs));
    yield item.ev;
  }
}

async function collectUntilError(
  it: AsyncIterable<ProviderEvent>,
): Promise<{ events: ProviderEvent[]; error: unknown }> {
  const events: ProviderEvent[] = [];
  try {
    for await (const ev of it) events.push(ev);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe("wrapProviderEventsWithContentIdleTimeout", () => {
  // The wrapper now samples a lastProgressAt timestamp on a coarse periodic
  // tick instead of re-arming a timer per event; these tests pass a fast tick
  // (well below timeoutMs) so expiry is still detected quickly in a test.
  const FAST_TICK_MS = 10;

  test("throws StreamIdleTimeoutError when the parsed stream stops yielding content", async () => {
    // The upstream iterable never resolves again after the first event — this
    // is the ping-hole scenario: bytes could keep flowing, but no more
    // ProviderEvents ever surface, so only the content deadline can catch it.
    async function* stalledAfterFirst(): AsyncIterable<ProviderEvent> {
      yield { kind: "text_delta", text: "hello" };
      await new Promise(() => {}); // never resolves
    }
    const wrapped = wrapProviderEventsWithContentIdleTimeout(stalledAfterFirst(), 30, FAST_TICK_MS);
    const { events, error } = await collectUntilError(wrapped);
    expect(events).toEqual([{ kind: "text_delta", text: "hello" }]);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    // idleMs reports the configured timeout, not the tick-lagged wall time it
    // actually took to notice — detection can lag by up to one tick.
    expect((error as StreamIdleTimeoutError).idleMs).toBe(30);
    expect((error as StreamIdleTimeoutError).kind).toBe("content");
  });

  test("content events re-arm the deadline — steady content never throws", async () => {
    const items = [
      { ev: { kind: "text_delta" as const, text: "a" }, delayMs: 5 },
      { ev: { kind: "text_delta" as const, text: "b" }, delayMs: 20 },
      { ev: { kind: "text_delta" as const, text: "c" }, delayMs: 20 },
      { ev: { kind: "message_stop" as const, stop_reason: "end_turn" }, delayMs: 20 },
    ];
    const wrapped = wrapProviderEventsWithContentIdleTimeout(
      delayedEvents(items),
      30,
      FAST_TICK_MS,
    );
    const { events, error } = await collectUntilError(wrapped);
    expect(error).toBeNull();
    expect(events.map((e) => e.kind)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "message_stop",
    ]);
  });

  test("throws before any event when the stream never produces a first event", async () => {
    // Retry classification of the thrown error is covered at the transport
    // layer (classify/__tests__/retry.test.ts) — kernel tests stay engine-free.
    async function* stalled(): AsyncIterable<ProviderEvent> {
      await new Promise(() => {});
    }
    const wrapped = wrapProviderEventsWithContentIdleTimeout(stalled(), 20, FAST_TICK_MS);
    const { events, error } = await collectUntilError(wrapped);
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).kind).toBe("content");
  });

  test("continuously producing upstream with downstream sleep longer than timeout after each yielded progress event does not timeout", async () => {
    async function* slowUpstream(): AsyncIterable<ProviderEvent> {
      yield { kind: "text_delta", text: "a" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { kind: "text_delta", text: "b" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { kind: "text_delta", text: "c" };
    }
    const wrapped = wrapProviderEventsWithContentIdleTimeout(slowUpstream(), 20, 5);
    const events: ProviderEvent[] = [];
    let error: unknown = null;
    try {
      for await (const ev of wrapped) {
        events.push(ev);
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
    } catch (err) {
      error = err;
    }
    expect(error).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "text_delta", "text_delta"]);
  });

  test("genuinely outstanding next with no progress times out", async () => {
    async function* slowUpstream(): AsyncIterable<ProviderEvent> {
      yield { kind: "text_delta", text: "a" };
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield { kind: "text_delta", text: "b" };
    }
    const wrapped = wrapProviderEventsWithContentIdleTimeout(slowUpstream(), 20, 5);
    const { events, error } = await collectUntilError(wrapped);
    expect(events).toEqual([{ kind: "text_delta", text: "a" }]);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).kind).toBe("content");
  });

  test("repeated non-progress events accumulate upstream wait and eventually timeout rather than rearm", async () => {
    async function* nonProgressUpstream(): AsyncIterable<ProviderEvent> {
      yield { kind: "text_delta", text: "a" };
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { kind: "retry_status", attempt: 1, maxAttempts: 5, delayMs: 0, reason: "" };
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { kind: "retry_status", attempt: 2, maxAttempts: 5, delayMs: 0, reason: "" };
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { kind: "retry_status", attempt: 3, maxAttempts: 5, delayMs: 0, reason: "" };
    }
    const wrapped = wrapProviderEventsWithContentIdleTimeout(nonProgressUpstream(), 40, 5);
    const { events, error } = await collectUntilError(wrapped);
    // Timer scheduling granularity determines which retry races with the deadline.
    // The contract is that control events do not prevent expiry, not an exact event count.
    expect(events[0]).toEqual({ kind: "text_delta", text: "a" });
    expect(events.slice(1).every((event) => event.kind === "retry_status")).toBe(true);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).kind).toBe("content");
  });
});
