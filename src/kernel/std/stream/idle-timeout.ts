import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { isEnvDefinedFalsy } from "@/kernel/std/proc/env.ts";

const SILENCE_NOTICE_MARKS_MS = [15_000, 30_000, 60_000, 120_000] as const;
const DELAY_REPORT_LAG_MS = 1_000;
const DEFAULT_BYTE_SILENCE_LIMIT_MS = 300_000;

// Keepalive streams carry a ping frame about every 25 seconds. Ninety seconds
// therefore tolerates three missed pings while still recovering a dead socket.
// The same window covers request upload because observation starts before the
// first response byte arrives.
export const KEEPALIVE_BYTE_SILENCE_LIMIT_MS = 90_000;

export type StreamSilenceScope = "byte" | "content";

export class StreamSilenceError extends Error {
  readonly silenceMs: number;
  readonly scope: StreamSilenceScope;

  constructor(silenceMs: number, scope: StreamSilenceScope = "byte") {
    super(
      scope === "content"
        ? `stream idle: no parsed content events for ${silenceMs}ms (byte traffic may still be flowing, e.g. keepalive pings)`
        : `stream idle: no bytes for ${silenceMs}ms`,
    );
    this.name = "StreamIdleTimeoutError";
    this.silenceMs = silenceMs;
    this.scope = scope;
  }
}

let byteGuardSetting: boolean | undefined;

export function byteSilenceGuardEnabled(): boolean {
  if (byteGuardSetting !== undefined) return byteGuardSetting;

  byteGuardSetting = !isEnvDefinedFalsy(process.env.OTHERSIDE_ENABLE_BYTE_WATCHDOG);
  return byteGuardSetting;
}

export function byteSilenceLimitMs(defaultLimitMs: number = DEFAULT_BYTE_SILENCE_LIMIT_MS): number {
  const configured = process.env.OTHERSIDE_STREAM_IDLE_TIMEOUT_MS;
  if (!configured) return defaultLimitMs;

  const parsedLimitMs = Number.parseInt(configured, 10);
  return Number.isFinite(parsedLimitMs) && parsedLimitMs > 0 ? parsedLimitMs : defaultLimitMs;
}

let traceSetting: boolean | undefined;

function traceEnabled(): boolean {
  if (traceSetting === undefined) traceSetting = devtoolBoolean("streamDebug");
  return traceSetting;
}

let traceDestination: string | undefined;

function resolveByteSilenceTracePath(): string {
  if (traceDestination !== undefined) return traceDestination;

  const directory = devtoolPath("debugLogDir") ?? join(configRoot(), "debug");
  try {
    mkdirSync(directory, { recursive: true });
  } catch {}
  traceDestination = join(directory, `stream-watchdog-${process.pid}.log`);
  return traceDestination;
}

function appendTrace(message: string): void {
  if (!traceEnabled()) return;

  const timestamp = performance.now().toFixed(1);
  try {
    appendFileSync(resolveByteSilenceTracePath(), `${timestamp} ${message}\n`);
  } catch {}
}

export interface ByteSilenceEvent {
  limitMs: number;
  delayedByMs: number;
  bytesSeen: number;
  outputClosed: boolean;
}

type ByteSilenceListener = (event: ByteSilenceEvent) => void;

let byteSilenceListener: ByteSilenceListener | null = null;
let delayedByteSilenceListener: ByteSilenceListener | null = null;

export function setByteSilenceListener(listener: ByteSilenceListener | null): void {
  byteSilenceListener = listener;
}

export function setDelayedByteSilenceListener(listener: ByteSilenceListener | null): void {
  delayedByteSilenceListener = listener;
}

type BytePipeController =
  | ReadableStreamDefaultController<Uint8Array>
  | TransformStreamDefaultController<Uint8Array>;
type TimerHandle = ReturnType<typeof setTimeout>;

function cancelTimer(handle: TimerHandle | null): null {
  if (handle !== null) clearTimeout(handle);
  return null;
}

function detachTimer(handle: TimerHandle): void {
  // On Windows the runtime does not fire unref'd timers while no other ref'd
  // handle is active, which would let a silent stream hang past its deadline.
  if (process.platform === "win32") return;
  const detachable = handle as TimerHandle & { unref?: () => void };
  detachable.unref?.();
}

function ignoreFailure(operation: () => void): void {
  try {
    operation();
  } catch {}
}

class ByteSilenceGuard {
  private expiryAlarm: TimerHandle | null = null;
  private noticeAlarm: TimerHandle | null = null;
  private noticeCursor = 0;
  private bytesObserved = 0;
  private latestByteMark = 0;
  private readonly transportStop = new AbortController();

  constructor(
    private readonly limitMs: number,
    private readonly onSilence?: (error: StreamSilenceError) => void,
  ) {}

  get signal(): AbortSignal {
    return this.transportStop.signal;
  }

  begin(output: BytePipeController): void {
    this.observeFromNow(output);
  }

  accept(byteCount: number, output: BytePipeController): void {
    this.bytesObserved += byteCount;
    this.observeFromNow(output);
  }

  finish(): void {
    this.clearSchedule();
  }

  stopTransport(reason: unknown): void {
    this.transportStop.abort(reason);
  }

  private silenceAgeMs(): number {
    return performance.now() - this.latestByteMark;
  }

  private clearSchedule(): void {
    this.expiryAlarm = cancelTimer(this.expiryAlarm);
    this.noticeAlarm = cancelTimer(this.noticeAlarm);
  }

  private observeFromNow(output: BytePipeController): void {
    this.clearSchedule();
    this.latestByteMark = performance.now();
    this.noticeCursor = 0;
    this.planNotice(output);
    this.planExpiry(output);
  }

  private planNotice(output: BytePipeController): void {
    this.noticeAlarm = cancelTimer(this.noticeAlarm);
    const noticeAtMs = SILENCE_NOTICE_MARKS_MS[this.noticeCursor];
    if (noticeAtMs === undefined) return;

    const waitMs = Math.max(0, noticeAtMs - this.silenceAgeMs());
    const alarm = setTimeout(() => this.reviewNotice(output, noticeAtMs), waitMs);
    this.noticeAlarm = alarm;
    detachTimer(alarm);
  }

  private reviewNotice(output: BytePipeController, noticeAtMs: number): void {
    this.noticeAlarm = null;
    if (output.desiredSize === null) return;

    if (this.silenceAgeMs() < noticeAtMs / 2) {
      this.planNotice(output);
      return;
    }

    appendTrace(
      `[Stall] stream_idle_partial lastChunkAgeMs=${Math.round(this.silenceAgeMs())} bytesTotal=${this.bytesObserved} idleDeadlineMs=${this.limitMs}`,
    );
    this.noticeCursor += 1;
    this.planNotice(output);
  }

  private planExpiry(output: BytePipeController): void {
    const alarm = setTimeout(() => this.expire(output), this.limitMs);
    this.expiryAlarm = alarm;
    detachTimer(alarm);
  }

  private expire(output: BytePipeController): void {
    this.expiryAlarm = null;
    const delayedByMs = Math.round(this.silenceAgeMs() - this.limitMs);
    const outputClosed = output.desiredSize === null;

    if (delayedByMs < -this.limitMs / 2) {
      appendTrace(`[byte-watchdog] suppressed: late=${delayedByMs}ms (sleep/suspend), re-arming`);
      this.observeFromNow(output);
      return;
    }

    appendTrace(
      `[byte-watchdog] firing: idle=${this.limitMs}ms late=${delayedByMs}ms errored=${outputClosed} bytesTotal=${this.bytesObserved}`,
    );
    const event: ByteSilenceEvent = {
      limitMs: this.limitMs,
      delayedByMs,
      bytesSeen: this.bytesObserved,
      outputClosed,
    };
    ignoreFailure(() => byteSilenceListener?.(event));
    if (delayedByMs >= DELAY_REPORT_LAG_MS) {
      ignoreFailure(() => delayedByteSilenceListener?.(event));
    }

    const error = new StreamSilenceError(this.limitMs);
    ignoreFailure(() => this.onSilence?.(error));
    ignoreFailure(() => output.error(error));
    // A transform error alone does not reliably release Bun's fetch body. The
    // pipe signal also closes the source transport before a retry begins.
    this.transportStop.abort(error);
  }
}

function bytePassThrough(guard: ByteSilenceGuard): Transformer<Uint8Array, Uint8Array> & {
  readableType?: undefined;
  writableType?: undefined;
} {
  return {
    start(output) {
      guard.begin(output);
    },
    transform(bytes, output) {
      guard.accept(bytes.byteLength, output);
      output.enqueue(bytes);
    },
    flush() {
      guard.finish();
    },
  };
}

type GuardedByteRead =
  | { done: false; value: Uint8Array }
  | { done: true; value: Uint8Array | undefined };

interface GuardedByteReader {
  read(): Promise<GuardedByteRead>;
  cancel(reason?: unknown): Promise<void>;
}

function exposeGuardedReader(
  reader: GuardedByteReader,
  guard: ByteSilenceGuard,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const item = await reader.read();
        if (item.done) {
          guard.finish();
          output.close();
        } else {
          output.enqueue(item.value);
        }
      } catch (reason) {
        guard.finish();
        output.error(reason);
      }
    },
    async cancel(reason) {
      guard.finish();
      try {
        await reader.cancel(reason);
      } finally {
        guard.stopTransport(reason);
      }
    },
  });
}

export function guardReadableByteSilence(
  source: ReadableStream<Uint8Array>,
  limitMs: number,
  onSilence?: (error: StreamSilenceError) => void,
): ReadableStream<Uint8Array> {
  const guard = new ByteSilenceGuard(limitMs, onSilence);
  const monitored = source.pipeThrough(new TransformStream(bytePassThrough(guard)), {
    signal: guard.signal,
  });
  return exposeGuardedReader(monitored.getReader(), guard);
}

export function maybeGuardReadableByteSilence(
  source: ReadableStream<Uint8Array>,
  defaultLimitMs?: number,
): ReadableStream<Uint8Array> {
  if (!byteSilenceGuardEnabled()) return source;
  return guardReadableByteSilence(source, byteSilenceLimitMs(defaultLimitMs));
}

function readableFromByteIterable(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const cursor = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const item = await cursor.next();
        if (item.done) {
          output.close();
        } else {
          output.enqueue(item.value);
        }
      } catch (reason) {
        output.error(reason);
      }
    },
    async cancel(reason) {
      try {
        await cursor.return?.(reason);
      } catch {}
    },
  });
}

export async function* guardByteIterableSilence(
  source: AsyncIterable<Uint8Array>,
  limitMs: number,
  onSilence?: (error: StreamSilenceError) => void,
): AsyncIterable<Uint8Array> {
  const guarded = guardReadableByteSilence(readableFromByteIterable(source), limitMs, onSilence);
  for await (const bytes of guarded as unknown as AsyncIterable<Uint8Array>) {
    yield bytes;
  }
}

export function maybeGuardByteIterableSilence(
  source: AsyncIterable<Uint8Array>,
  defaultLimitMs?: number,
  onSilence?: (error: StreamSilenceError) => void,
): AsyncIterable<Uint8Array> {
  if (!byteSilenceGuardEnabled()) return source;
  return guardByteIterableSilence(source, byteSilenceLimitMs(defaultLimitMs), onSilence);
}
