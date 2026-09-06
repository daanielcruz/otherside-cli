import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type ByteSilenceEvent,
  byteSilenceLimitMs,
  guardByteIterableSilence,
  guardReadableByteSilence,
  KEEPALIVE_BYTE_SILENCE_LIMIT_MS,
  StreamSilenceError,
  setByteSilenceListener,
  setDelayedByteSilenceListener,
} from "../idle-timeout.ts";

const LIMIT_ENV_KEY = "OTHERSIDE_STREAM_IDLE_TIMEOUT_MS";

function delayedByteStream(
  entries: ReadonlyArray<{ bytes: Uint8Array; delayMs: number }>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(output) {
      try {
        for (const entry of entries) {
          await Bun.sleep(entry.delayMs);
          output.enqueue(entry.bytes);
        }
        output.close();
      } catch {}
    },
  });
}

async function collectBytes(source: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const bytes of source as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(bytes);
  }
  return chunks;
}

async function rejectedBy(source: ReadableStream<Uint8Array>): Promise<unknown> {
  return collectBytes(source).catch((reason) => reason);
}

interface ManualAlarm {
  readonly delayMs: number;
  readonly handle: ReturnType<typeof setTimeout>;
  active: boolean;
  fire(): void;
}

interface ManualTime {
  readonly alarms: ManualAlarm[];
  setNow(value: number): void;
  activeAlarm(delayMs: number): ManualAlarm;
  restore(): void;
}

function installManualTime(): ManualTime {
  let now = 0;
  const alarms: ManualAlarm[] = [];
  const nowSpy = spyOn(performance, "now").mockImplementation(() => now);
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    const alarm: ManualAlarm = {
      delayMs: Number(delay ?? 0),
      handle,
      active: true,
      fire() {
        if (!alarm.active) throw new Error("alarm is no longer active");
        alarm.active = false;
        if (typeof callback === "function") callback(...args);
      },
    };
    alarms.push(alarm);
    return handle;
  }) as typeof setTimeout);
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle: ReturnType<typeof setTimeout> | undefined,
  ) => {
    const alarm = alarms.find((candidate) => candidate.handle === handle);
    if (alarm) alarm.active = false;
  }) as typeof clearTimeout);

  return {
    alarms,
    setNow(value) {
      now = value;
    },
    activeAlarm(delayMs) {
      const alarm = alarms.findLast(
        (candidate) => candidate.active && candidate.delayMs === delayMs,
      );
      if (!alarm) throw new Error(`no active ${delayMs}ms alarm`);
      return alarm;
    },
    restore() {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      nowSpy.mockRestore();
    },
  };
}

afterEach(() => {
  delete process.env[LIMIT_ENV_KEY];
  setByteSilenceListener(null);
  setDelayedByteSilenceListener(null);
});

describe("byteSilenceLimitMs", () => {
  test("uses the quiet-stream default", () => {
    expect(byteSilenceLimitMs()).toBe(300_000);
  });

  test("accepts a keepalive-specific default", () => {
    expect(byteSilenceLimitMs(KEEPALIVE_BYTE_SILENCE_LIMIT_MS)).toBe(90_000);
  });

  test("lets a positive environment value override either default", () => {
    process.env[LIMIT_ENV_KEY] = "45000";
    expect(byteSilenceLimitMs()).toBe(45_000);
    expect(byteSilenceLimitMs(KEEPALIVE_BYTE_SILENCE_LIMIT_MS)).toBe(45_000);
  });

  test("rejects invalid and non-positive environment values", () => {
    process.env[LIMIT_ENV_KEY] = "not-a-number";
    expect(byteSilenceLimitMs()).toBe(300_000);
    expect(byteSilenceLimitMs(KEEPALIVE_BYTE_SILENCE_LIMIT_MS)).toBe(90_000);
    process.env[LIMIT_ENV_KEY] = "0";
    expect(byteSilenceLimitMs(KEEPALIVE_BYTE_SILENCE_LIMIT_MS)).toBe(90_000);
  });
});

describe("StreamSilenceError", () => {
  test("keeps the byte-timeout error contract", () => {
    const error = new StreamSilenceError(90_000);
    expect(error.name).toBe("StreamIdleTimeoutError");
    expect(error.message).toBe("stream idle: no bytes for 90000ms");
    expect(error.silenceMs).toBe(90_000);
    expect(error.scope).toBe("byte");
  });

  test("keeps the content-timeout error contract", () => {
    const error = new StreamSilenceError(180_000, "content");
    expect(error.name).toBe("StreamIdleTimeoutError");
    expect(error.message).toBe(
      "stream idle: no parsed content events for 180000ms (byte traffic may still be flowing, e.g. keepalive pings)",
    );
    expect(error.silenceMs).toBe(180_000);
    expect(error.scope).toBe("content");
  });
});

describe("guardReadableByteSilence", () => {
  const ONE_BYTE = new Uint8Array([1]);

  test("covers the wait for the first byte", async () => {
    const guarded = guardReadableByteSilence(
      delayedByteStream([{ bytes: ONE_BYTE, delayMs: 150 }]),
      40,
    );
    const error = await rejectedBy(guarded);
    expect(error).toBeInstanceOf(StreamSilenceError);
    expect((error as StreamSilenceError).silenceMs).toBe(40);
  });

  test("resets the limit after every byte chunk", async () => {
    const guarded = guardReadableByteSilence(
      delayedByteStream([
        { bytes: ONE_BYTE, delayMs: 20 },
        { bytes: new Uint8Array([2, 3]), delayMs: 20 },
      ]),
      35,
    );
    expect(await collectBytes(guarded)).toEqual([ONE_BYTE, new Uint8Array([2, 3])]);
  });

  test("fails when a gap between chunks exceeds the limit", async () => {
    const guarded = guardReadableByteSilence(
      delayedByteStream([
        { bytes: ONE_BYTE, delayMs: 5 },
        { bytes: ONE_BYTE, delayMs: 80 },
      ]),
      25,
    );
    expect(await rejectedBy(guarded)).toBeInstanceOf(StreamSilenceError);
  });

  test("passes chunk objects through without copying", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3]);
    const chunks = await collectBytes(
      guardReadableByteSilence(
        delayedByteStream([
          { bytes: first, delayMs: 1 },
          { bytes: second, delayMs: 1 },
        ]),
        100,
      ),
    );
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  test("uses one error for the callback, consumer, and source cancellation", async () => {
    let silenceCallbackFailure: StreamSilenceError | undefined;
    let cancellationReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const guarded = guardReadableByteSilence(source, 20, (error) => {
      silenceCallbackFailure = error;
    });

    const consumerError = await rejectedBy(guarded);
    await Bun.sleep(0);
    expect(consumerError).toBe(silenceCallbackFailure);
    expect(cancellationReason).toBe(consumerError);
  });

  test("still fails the stream when observers throw", async () => {
    setByteSilenceListener(() => {
      throw new Error("listener failed");
    });
    const guarded = guardReadableByteSilence(new ReadableStream<Uint8Array>({}), 10, () => {
      throw new Error("callback failed");
    });
    expect(await rejectedBy(guarded)).toBeInstanceOf(StreamSilenceError);
  });

  test("forwards source failures unchanged", async () => {
    const sourceFailure = new Error("source failed");
    const source = new ReadableStream<Uint8Array>({
      start(output) {
        output.error(sourceFailure);
      },
    });
    expect(await rejectedBy(guardReadableByteSilence(source, 100))).toBe(sourceFailure);
  });

  test("does not report silence after consumer cancellation", async () => {
    let reports = 0;
    const guarded = guardReadableByteSilence(new ReadableStream<Uint8Array>({}), 15, () => {
      reports += 1;
    });
    await guarded.cancel("complete");
    await Bun.sleep(30);
    expect(reports).toBe(0);
  });

  test("emits cumulative bytes and delivery lag to both observer tiers", async () => {
    const time = installManualTime();
    const regular: ByteSilenceEvent[] = [];
    const delayed: ByteSilenceEvent[] = [];
    setByteSilenceListener((event) => regular.push(event));
    setDelayedByteSilenceListener((event) => delayed.push(event));
    let sourceOutput: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(output) {
        sourceOutput = output;
      },
    });

    try {
      const reader = guardReadableByteSilence(source, 5_000).getReader();
      const firstRead = reader.read();
      time.setNow(100);
      sourceOutput?.enqueue(new Uint8Array([1, 2, 3]));
      await firstRead;

      const rejectedRead = reader.read().catch((reason) => reason);
      time.setNow(6_101);
      time.activeAlarm(5_000).fire();
      const error = await rejectedRead;
      expect(error).toBeInstanceOf(StreamSilenceError);
      expect(regular).toEqual([
        {
          limitMs: 5_000,
          delayedByMs: 1_001,
          bytesSeen: 3,
          outputClosed: false,
        },
      ]);
      expect(delayed).toEqual(regular);
    } finally {
      time.restore();
    }
  });

  test("suppresses an early expiry callback and starts a fresh observation window", async () => {
    const time = installManualTime();
    const events: ByteSilenceEvent[] = [];
    setByteSilenceListener((event) => events.push(event));

    try {
      const reader = guardReadableByteSilence(
        new ReadableStream<Uint8Array>({}),
        5_000,
      ).getReader();
      const pendingRead = reader.read().catch((reason) => reason);
      time.activeAlarm(5_000).fire();
      expect(events).toEqual([]);

      time.setNow(5_000);
      time.activeAlarm(5_000).fire();
      expect(await pendingRead).toBeInstanceOf(StreamSilenceError);
      expect(events).toHaveLength(1);
    } finally {
      time.restore();
    }
  });

  test("advances the silence notices at 15, 30, 60, and 120 seconds", () => {
    const time = installManualTime();
    try {
      guardReadableByteSilence(new ReadableStream<Uint8Array>({}), 300_000);
      const first = time.activeAlarm(15_000);
      time.setNow(15_000);
      first.fire();
      const second = time.activeAlarm(15_000);
      time.setNow(30_000);
      second.fire();
      const third = time.activeAlarm(30_000);
      time.setNow(60_000);
      third.fire();
      const fourth = time.activeAlarm(60_000);
      time.setNow(120_000);
      fourth.fire();
      expect(time.alarms.filter((alarm) => alarm.active).map((alarm) => alarm.delayMs)).toEqual([
        300_000,
      ]);
    } finally {
      time.restore();
    }
  });
});

describe("guardByteIterableSilence", () => {
  test("preserves byte order across the iterable adapter", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      yield new Uint8Array([2, 3]);
    }
    const chunks: number[][] = [];
    for await (const bytes of guardByteIterableSilence(source(), 100)) {
      chunks.push([...bytes]);
    }
    expect(chunks).toEqual([[1], [2, 3]]);
  });

  test("closes a stalled iterator when the byte limit expires", async () => {
    let iteratorReleased = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            iteratorReleased = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    let error: unknown;
    try {
      for await (const _bytes of guardByteIterableSilence(source, 15)) {
        throw new Error("unexpected bytes");
      }
    } catch (reason) {
      error = reason;
    }
    await Bun.sleep(0);
    expect(error).toBeInstanceOf(StreamSilenceError);
    expect(iteratorReleased).toBe(true);
  });
});
