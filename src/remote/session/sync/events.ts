import type { BackgroundTaskStatus } from "@/kernel/channels/background-tasks.ts";
import { subscribeEnvBroadcast, subscribePushEvent } from "@/kernel/channels/session-events.ts";
export type PushEmitter = (eventType: string, plaintext: string) => Promise<void>;
export type EnvEmitter = (plaintext: string) => Promise<void>;

let activePushEmitter: PushEmitter | null = null;
let activeEnvEmitter: EnvEmitter | null = null;

export function setActivePushEmitter(emitter: PushEmitter | null): void {
  activePushEmitter = emitter;
}

export function setActiveEnvEmitter(emitter: EnvEmitter | null): void {
  activeEnvEmitter = emitter;
}

export function clearActiveEmitters(): void {
  activePushEmitter = null;
  activeEnvEmitter = null;
}

// try/catch shields callers (engine observers) from an emitter that throws
// synchronously; the .catch swallows async failures the same way.
export function emitPushEvent(eventType: string, plaintext: string): void {
  try {
    void activePushEmitter?.(eventType, plaintext).catch(() => {});
  } catch {}
}

export function emitEnvBroadcast(plaintext: string): void {
  try {
    void activeEnvEmitter?.(plaintext).catch(() => {});
  } catch {}
}

export function bgCompletionStatus(status: BackgroundTaskStatus): string {
  if (status === "killed") return "stopped";
  if (status === "error") return "failed";
  return "completed";
}

subscribePushEvent((eventType, plaintext) => emitPushEvent(eventType, plaintext));
subscribeEnvBroadcast((plaintext) => emitEnvBroadcast(plaintext));
