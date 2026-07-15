import { useSyncExternalStore } from "react";

const METER_FLUSH_MS = 300;

let liveValue = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function readLiveOutputTokens(): number {
  return liveValue;
}

export function setLiveOutputTokens(value: number): void {
  liveValue = value;
  if (value === 0) {
    cancelFlush();
    emit();
    return;
  }
  scheduleFlush();
}

export function addLiveOutputTokens(delta: number): void {
  setLiveOutputTokens(liveValue + delta);
}

function subscribeLiveOutputTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLiveOutputTokens(): number {
  return useSyncExternalStore(
    subscribeLiveOutputTokens,
    readLiveOutputTokens,
    readLiveOutputTokens,
  );
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    emit();
  }, METER_FLUSH_MS);
  flushTimer.unref?.();
}

function cancelFlush(): void {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}
