import {
  getStreamIdleTimeoutMs,
  StreamIdleTimeoutError,
} from "@/kernel/std/stream/idle-timeout.ts";

export interface CodexStreamDeadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  arm(): void;
  dispose(): void;
  timedOut(): boolean;
  timeoutError(): StreamIdleTimeoutError;
}

export function createCodexStreamDeadline(
  parentSignal?: AbortSignal,
  onTimeout?: (err: StreamIdleTimeoutError) => void,
): CodexStreamDeadline {
  const timeoutMs = getStreamIdleTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let didTimeOut = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const timeoutError = (): StreamIdleTimeoutError => new StreamIdleTimeoutError(timeoutMs);

  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
  };

  const onParentAbort = (): void => {
    clearTimer();
    abort(parentSignal?.reason ?? new Error("aborted"));
  };

  const arm = (): void => {
    clearTimer();
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = null;
      didTimeOut = true;
      const err = timeoutError();
      abort(err);
      onTimeout?.(err);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    arm();
  }

  return {
    signal: controller.signal,
    timeoutMs,
    arm,
    dispose: () => {
      clearTimer();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => didTimeOut,
    timeoutError,
  };
}

export function throwIfCodexDeadlineTimedOut(deadline: CodexStreamDeadline): void {
  if (deadline.timedOut()) throw deadline.timeoutError();
}
