import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";

// Per-fork user-steering queues: text submitted from the agent view while the
// agent runs. Drained by the fork loop at its existing queued-input boundaries
// (turn start, between iterations, after tool batches) — the same delivery
// semantics as the main loop's queued messages.
const EMPTY_STEERS: readonly DrainedQueuedMessage[] = [];
const queues = new Map<string, DrainedQueuedMessage[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeAgentSteers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function queueAgentSteer(forkId: string, message: DrainedQueuedMessage): void {
  const queued = { ...message, queueId: message.queueId ?? crypto.randomUUID() };
  queues.set(forkId, [...(queues.get(forkId) ?? []), queued]);
  emit();
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

export function clearAgentSteers(forkId: string): void {
  if (queues.delete(forkId)) emit();
}
