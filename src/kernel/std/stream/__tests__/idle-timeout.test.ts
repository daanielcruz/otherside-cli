import { afterEach, describe, expect, test } from "bun:test";
import {
  getStreamIdleTimeoutMs,
  KEEPALIVE_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  wrapStreamWithIdleTimeout,
} from "../idle-timeout.ts";

const ENV_KEY = "OTHERSIDE_STREAM_IDLE_TIMEOUT_MS";

describe("getStreamIdleTimeoutMs", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("defaults to the generous non-keepalive window", () => {
    delete process.env[ENV_KEY];
    expect(getStreamIdleTimeoutMs()).toBe(300_000);
  });

  test("keepalive providers pass the tight window as fallback", () => {
    delete process.env[ENV_KEY];
    expect(getStreamIdleTimeoutMs(KEEPALIVE_IDLE_TIMEOUT_MS)).toBe(90_000);
  });

  test("env override wins over every provider fallback", () => {
    process.env[ENV_KEY] = "45000";
    expect(getStreamIdleTimeoutMs()).toBe(45_000);
    expect(getStreamIdleTimeoutMs(KEEPALIVE_IDLE_TIMEOUT_MS)).toBe(45_000);
  });

  test("invalid or non-positive env falls back to the provided default", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(getStreamIdleTimeoutMs()).toBe(300_000);
    expect(getStreamIdleTimeoutMs(KEEPALIVE_IDLE_TIMEOUT_MS)).toBe(90_000);
    process.env[ENV_KEY] = "0";
    expect(getStreamIdleTimeoutMs(KEEPALIVE_IDLE_TIMEOUT_MS)).toBe(90_000);
  });
});

function streamOf(chunks: { data: Uint8Array; delayMs: number }[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
          controller.enqueue(chunk.data);
        }
        controller.close();
      } catch {}
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
  }
  return bytes;
}

describe("wrapStreamWithIdleTimeout — single idle deadline", () => {
  const BYTE = new Uint8Array([1]);

  test("the idle deadline governs from the start, covering time to first byte", async () => {
    const wrapped = wrapStreamWithIdleTimeout(streamOf([{ data: BYTE, delayMs: 150 }]), 50);
    const error = await drain(wrapped).catch((err) => err);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).idleMs).toBe(50);
  });

  test("a slow first byte within the deadline does not fire", async () => {
    const wrapped = wrapStreamWithIdleTimeout(streamOf([{ data: BYTE, delayMs: 60 }]), 500);
    expect(await drain(wrapped)).toBe(1);
  });

  test("fires when the gap between bytes exceeds the deadline", async () => {
    const wrapped = wrapStreamWithIdleTimeout(
      streamOf([
        { data: BYTE, delayMs: 5 },
        { data: BYTE, delayMs: 400 },
      ]),
      60,
    );
    const error = await drain(wrapped).catch((err) => err);
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect((error as StreamIdleTimeoutError).idleMs).toBe(60);
  });

  test("a healthy stream under the deadline passes through untouched", async () => {
    const wrapped = wrapStreamWithIdleTimeout(
      streamOf([
        { data: BYTE, delayMs: 5 },
        { data: BYTE, delayMs: 10 },
      ]),
      200,
    );
    expect(await drain(wrapped)).toBe(2);
  });

  test("cancels the source stream when the watchdog fires", async () => {
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const attemptAbort = new AbortController();
    const wrapped = wrapStreamWithIdleTimeout(source, 30, (error) => attemptAbort.abort(error));
    const error = await drain(wrapped).catch((err) => err);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toBeInstanceOf(StreamIdleTimeoutError);
    expect(cancelReason).toBeInstanceOf(StreamIdleTimeoutError);
    expect(attemptAbort.signal.aborted).toBe(true);
    expect(attemptAbort.signal.reason).toBe(error);
  });

  test("does not fire after the consumer cancels the wrapped stream", async () => {
    let fired = false;
    const wrapped = wrapStreamWithIdleTimeout(new ReadableStream<Uint8Array>({}), 20, () => {
      fired = true;
    });

    await wrapped.cancel("done");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fired).toBe(false);
  });
});
