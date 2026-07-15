import { subscribeQueuedInputDrained } from "@/kernel/channels/session-events.ts";
import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import { emitPushEvent } from "./events.ts";

// Wire contract with the companion app's queued-message ledger: when the
// engine drains queued inputs into a turn, the app must clear the matching
// `queued_input` entries or they linger as a ghost queue. The app matches by
// queue id when the payload carries one, and falls back to an exact text
// match otherwise — so each drained message becomes its own event with
// plaintext `{ text, queue_id? }`. These are fire-and-forget UI events, not
// durable records: a lost send degrades to the app's text-match fallback.
export function queuedInputDrainedPlaintext(message: DrainedQueuedMessage): string {
  const remotePayload =
    message.remotePayload && typeof message.remotePayload === "object"
      ? (message.remotePayload as Record<string, unknown>)
      : null;
  const queueId = remotePayload
    ? (remotePayload.queueId ?? remotePayload.queue_id ?? remotePayload.id)
    : undefined;
  return JSON.stringify({
    text: message.text,
    ...(typeof queueId === "string" ? { queue_id: queueId } : {}),
  });
}

// Routed through the active push emitter, which only sends while a sync
// session is registered and swallows delivery failures — safe to call from
// the engine turn loop.
export function emitQueuedInputDrained(messages: readonly DrainedQueuedMessage[]): void {
  for (const message of messages) {
    emitPushEvent("queued_input_drained", queuedInputDrainedPlaintext(message));
  }
}

// The local queue is always empty when a CLI process boots, but the app's
// ledger may still hold entries from a prior process that never emitted its
// drains (crash, old binary). A reset marker on first registration lets the
// app discard everything queued before it.
export function emitQueueReset(): void {
  emitPushEvent("queue_reset", JSON.stringify({}));
}

subscribeQueuedInputDrained(emitQueuedInputDrained);
