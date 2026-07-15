import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { devtoolBoolean, devtoolPath } from "@/devtools/settings.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/proc/env.ts";

const STALL_CHECKPOINT_MS = [15000, 30000, 60000, 120000] as const;
const LATE_FIRE_REPORT_THRESHOLD_MS = 1000;
// Keepalive streams carry a ping frame ~every 25s, so a short deadline cannot
// false-fire on a healthy connection: 90s idle = 3+ missed pings = dead socket
// (a VPN/path change otherwise hangs until the quiet-provider 300s deadline).
// The same 90s governs time-to-first-byte: the deadline is armed before the
// request fires, so it must also cover uploading a media-heavy body — a
// tighter first-byte deadline turns a slow upload into an unrecoverable
// retry loop that re-sends the same large body every attempt.
export const KEEPALIVE_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export type StreamIdleTimeoutKind = "byte" | "content";

export class StreamIdleTimeoutError extends Error {
  idleMs: number;
  kind: StreamIdleTimeoutKind;
  constructor(idleMs: number, kind: StreamIdleTimeoutKind = "byte") {
    super(
      kind === "content"
        ? `stream idle: no parsed content events for ${idleMs}ms (byte traffic may still be flowing, e.g. keepalive pings)`
        : `stream idle: no bytes for ${idleMs}ms`,
    );
    this.name = "StreamIdleTimeoutError";
    this.idleMs = idleMs;
    this.kind = kind;
  }
}

let watchdogFlag: boolean | undefined;

export function isStreamWatchdogEnabled(): boolean {
  if (watchdogFlag !== undefined) return watchdogFlag;
  if (isEnvDefinedFalsy(process.env.OTHERSIDE_ENABLE_BYTE_WATCHDOG)) {
    watchdogFlag = false;
    return false;
  }
  if (isEnvTruthy(process.env.OTHERSIDE_ENABLE_BYTE_WATCHDOG)) {
    watchdogFlag = true;
    return true;
  }
  watchdogFlag = true;
  return true;
}

export function getStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_IDLE_TIMEOUT_MS): number {
  const raw = process.env.OTHERSIDE_STREAM_IDLE_TIMEOUT_MS;
  if (!raw) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

let debugFlag: boolean | undefined;

function isDebugEnabled(): boolean {
  if (debugFlag !== undefined) return debugFlag;
  debugFlag = devtoolBoolean("streamDebug");
  return debugFlag;
}

let debugLogPath: string | undefined;

function resolveDebugLogPath(): string {
  if (debugLogPath) return debugLogPath;
  const dir = devtoolPath("debugLogDir") ?? join(configRoot(), "debug");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  debugLogPath = join(dir, `stream-watchdog-${process.pid}.log`);
  return debugLogPath;
}

function writeDebug(line: string): void {
  if (!isDebugEnabled()) return;
  const stamp = performance.now().toFixed(1);
  try {
    appendFileSync(resolveDebugLogPath(), `${stamp} ${line}\n`);
  } catch {}
}

export interface WatchdogFiredEvent {
  idleMs: number;
  lateMs: number;
  bytesTotal: number;
  readableErrored: boolean;
}

type FiredHook = (event: WatchdogFiredEvent) => void;
type LateFiredHook = (event: WatchdogFiredEvent) => void;

let firedHook: FiredHook | null = null;
let lateFiredHook: LateFiredHook | null = null;

export function setWatchdogFiredHook(hook: FiredHook | null): void {
  firedHook = hook;
}

export function setWatchdogFiredLateHook(hook: LateFiredHook | null): void {
  lateFiredHook = hook;
}

type Controller =
  | ReadableStreamDefaultController<Uint8Array>
  | TransformStreamDefaultController<Uint8Array>;

export function wrapStreamWithIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
  onTimeout?: (error: StreamIdleTimeoutError) => void,
): ReadableStream<Uint8Array> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressIdx = 0;
  let bytesTotal = 0;
  let lastChunkAt = 0;
  const pipeAbort = new AbortController();

  const clearProgress = (): void => {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  const clearDeadline = (): void => {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  const clearBoth = (): void => {
    clearDeadline();
    clearProgress();
  };

  const scheduleProgress = (controller: Controller): void => {
    clearProgress();
    if (progressIdx >= STALL_CHECKPOINT_MS.length) return;
    const target = STALL_CHECKPOINT_MS[progressIdx]!;
    const elapsed = performance.now() - lastChunkAt;
    progressTimer = setTimeout(
      () => {
        progressTimer = null;
        if (controller.desiredSize === null) return;
        if (performance.now() - lastChunkAt < target / 2) {
          scheduleProgress(controller);
          return;
        }
        writeDebug(
          `[Stall] stream_idle_partial lastChunkAgeMs=${Math.round(performance.now() - lastChunkAt)} bytesTotal=${bytesTotal} idleDeadlineMs=${timeoutMs}`,
        );
        progressIdx++;
        scheduleProgress(controller);
      },
      Math.max(0, target - elapsed),
    );
    (progressTimer as { unref?: () => void } | null)?.unref?.();
  };

  const armBoth = (controller: Controller): void => {
    clearBoth();
    lastChunkAt = performance.now();
    progressIdx = 0;
    scheduleProgress(controller);
    const deadlineMs = timeoutMs;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      const lateMs = Math.round(performance.now() - lastChunkAt - deadlineMs);
      const readableErrored = controller.desiredSize === null;
      if (lateMs < -deadlineMs / 2) {
        writeDebug(`[byte-watchdog] suppressed: late=${lateMs}ms (sleep/suspend), re-arming`);
        armBoth(controller);
        return;
      }
      writeDebug(
        `[byte-watchdog] firing: idle=${deadlineMs}ms late=${lateMs}ms errored=${readableErrored} bytesTotal=${bytesTotal}`,
      );
      const event: WatchdogFiredEvent = {
        idleMs: deadlineMs,
        lateMs,
        bytesTotal,
        readableErrored,
      };
      try {
        firedHook?.(event);
      } catch {}
      if (lateMs >= LATE_FIRE_REPORT_THRESHOLD_MS) {
        try {
          lateFiredHook?.(event);
        } catch {}
      }
      const error = new StreamIdleTimeoutError(deadlineMs);
      try {
        onTimeout?.(error);
      } catch {}
      try {
        controller.error(error);
      } catch {}
      // Erroring the transform does not reliably cancel Bun's fetch body. Abort
      // the pipe explicitly so the source reader closes its transport; otherwise
      // the retry can keep selecting the same live-but-wedged pooled socket.
      pipeAbort.abort(error);
    }, deadlineMs);
    (deadlineTimer as { unref?: () => void } | null)?.unref?.();
  };

  const transformed = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        armBoth(controller);
      },
      transform(chunk, controller) {
        bytesTotal += chunk.byteLength;
        armBoth(controller);
        controller.enqueue(chunk);
      },
      flush() {
        clearBoth();
      },
    }),
    { signal: pipeAbort.signal },
  );
  const reader = transformed.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          clearBoth();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        clearBoth();
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearBoth();
      try {
        await reader.cancel(reason);
      } finally {
        pipeAbort.abort(reason);
      }
    },
  });
}

export function maybeWrapWithIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  fallbackMs?: number,
): ReadableStream<Uint8Array> {
  if (!isStreamWatchdogEnabled()) return stream;
  return wrapStreamWithIdleTimeout(stream, getStreamIdleTimeoutMs(fallbackMs));
}

function asyncIterToReadable(iter: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = iter[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await it.return?.(reason);
      } catch {}
    },
  });
}

export async function* wrapAsyncIterableWithIdleTimeout(
  iter: AsyncIterable<Uint8Array>,
  timeoutMs: number,
  onTimeout?: (error: StreamIdleTimeoutError) => void,
): AsyncIterable<Uint8Array> {
  const wrapped = wrapStreamWithIdleTimeout(asyncIterToReadable(iter), timeoutMs, onTimeout);
  for await (const chunk of wrapped as unknown as AsyncIterable<Uint8Array>) yield chunk;
}

export function maybeWrapAsyncIterableWithIdleTimeout(
  iter: AsyncIterable<Uint8Array>,
  fallbackMs?: number,
  onTimeout?: (error: StreamIdleTimeoutError) => void,
): AsyncIterable<Uint8Array> {
  if (!isStreamWatchdogEnabled()) return iter;
  return wrapAsyncIterableWithIdleTimeout(iter, getStreamIdleTimeoutMs(fallbackMs), onTimeout);
}
