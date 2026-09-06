import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";

// Per-fork user-steering queues: text submitted from the agent view while the
// agent runs. Drained by the fork loop at its existing queued-input boundaries
// (turn start, between iterations, after tool batches) — the same delivery
// semantics as the main loop's queued messages.
const EMPTY_STEERS: readonly DrainedQueuedMessage[] = [];
const EMIT_THROTTLE_MS = 250;
const queues = new Map<string, DrainedQueuedMessage[]>();
const listeners = new Set<() => void>();
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let emitPending = false;

// Leading+trailing throttle: the first change notifies immediately, a burst
// inside the window folds into one trailing notification.
function emit(): void {
  if (emitTimer !== null) {
    emitPending = true;
    return;
  }
  for (const listener of listeners) listener();
  emitTimer = setTimeout(() => {
    emitTimer = null;
    if (emitPending) {
      emitPending = false;
      emit();
    }
  }, EMIT_THROTTLE_MS);
  (emitTimer as { unref?: () => void }).unref?.();
}

export function subscribeAgentSteers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetSteerEmitThrottleForTests(): void {
  if (emitTimer !== null) clearTimeout(emitTimer);
  emitTimer = null;
  emitPending = false;
}

export function queueAgentSteer(forkId: string, message: DrainedQueuedMessage): void {
  const queued = { ...message, queueId: message.queueId ?? crypto.randomUUID() };
  queues.set(forkId, [...(queues.get(forkId) ?? []), queued]);
  emit();
}

/**
 * Resolves when the fork has at least one queued steer (immediately if one is
 * already waiting) or when the signal aborts — the same wake contract as the
 * owner-inventory wait, so a parked loop can race both and take whichever
 * input arrives first. Resolution is a wake-up, never a claim: the loop's own
 * drainer consumes the queue.
 */
export function waitForAgentSteer(forkId: string, signal?: AbortSignal): Promise<void> {
  if (pendingAgentSteerCount(forkId) > 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let unsubscribe = (): void => {};
    const finish = (): void => {
      unsubscribe();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    unsubscribe = subscribeAgentSteers(() => {
      if (pendingAgentSteerCount(forkId) > 0) finish();
    });
    signal?.addEventListener("abort", finish, { once: true });
    if (pendingAgentSteerCount(forkId) > 0 || signal?.aborted === true) finish();
  });
}

export function pendingAgentSteers(forkId: string): readonly DrainedQueuedMessage[] {
  return queues.get(forkId) ?? EMPTY_STEERS;
}

export function drainAgentSteers(forkId: string): DrainedQueuedMessage[] {
  const queue = queues.get(forkId);
  if (!queue || queue.length === 0) return [];
  queues.delete(forkId);
  emit();
  return queue;
}

export function pendingAgentSteerCount(forkId: string): number {
  return queues.get(forkId)?.length ?? 0;
}

/**
 * Remove and return the listed steers, leaving every other one queued in order.
 * A resume claims only what was already waiting when it was accepted; a message
 * that arrives while the resume is being prepared belongs after its prompt, so it
 * stays here for the resumed loop's own drainer.
 */
export function takeAgentSteers(forkId: string, ids: ReadonlySet<string>): DrainedQueuedMessage[] {
  const queue = queues.get(forkId);
  if (!queue || queue.length === 0) return [];
  const taken: DrainedQueuedMessage[] = [];
  const kept: DrainedQueuedMessage[] = [];
  for (const message of queue) {
    const claimed = message.queueId !== undefined && ids.has(message.queueId);
    (claimed ? taken : kept).push(message);
  }
  if (taken.length === 0) return [];
  kept.length === 0 ? queues.delete(forkId) : queues.set(forkId, kept);
  emit();
  return taken;
}

export function clearAgentSteers(forkId: string): void {
  if (queues.delete(forkId)) emit();
}
