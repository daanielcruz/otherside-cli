import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";

export type SessionStatus = "streaming" | "idle" | "awaiting" | "disconnected" | "ended";

type PushEventListener = (eventType: string, plaintext: string) => void;
type EnvBroadcastListener = (plaintext: string) => void;
type QueuedInputDrainedListener = (messages: readonly DrainedQueuedMessage[]) => void;
type SessionStatusListener = (status: SessionStatus) => void;

const pushEventListeners = new Set<PushEventListener>();
const envBroadcastListeners = new Set<EnvBroadcastListener>();
const queuedInputDrainedListeners = new Set<QueuedInputDrainedListener>();
const sessionStatusListeners = new Set<SessionStatusListener>();

function subscribe<T>(listeners: Set<T>, fn: T): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitPushEvent(eventType: string, plaintext: string): void {
  for (const fn of pushEventListeners) fn(eventType, plaintext);
}

export function subscribePushEvent(fn: PushEventListener): () => void {
  return subscribe(pushEventListeners, fn);
}

export function emitEnvBroadcast(plaintext: string): void {
  for (const fn of envBroadcastListeners) fn(plaintext);
}

export function subscribeEnvBroadcast(fn: EnvBroadcastListener): () => void {
  return subscribe(envBroadcastListeners, fn);
}

export function emitQueuedInputDrained(messages: readonly DrainedQueuedMessage[]): void {
  for (const fn of queuedInputDrainedListeners) fn(messages);
}

export function subscribeQueuedInputDrained(fn: QueuedInputDrainedListener): () => void {
  return subscribe(queuedInputDrainedListeners, fn);
}

export function emitSessionStatus(status: SessionStatus): void {
  for (const fn of sessionStatusListeners) fn(status);
}

export function subscribeSessionStatus(fn: SessionStatusListener): () => void {
  return subscribe(sessionStatusListeners, fn);
}
