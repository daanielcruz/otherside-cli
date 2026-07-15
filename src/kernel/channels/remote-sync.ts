import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";

let syncStatus: RemoteSyncStatus = "disconnected";
const statusListeners = new Set<(status: RemoteSyncStatus) => void>();
const invalidatedListeners = new Set<() => void>();

export function getRemoteSyncStatus(): RemoteSyncStatus {
  return syncStatus;
}

export function setRemoteSyncStatus(status: RemoteSyncStatus): void {
  if (status === syncStatus) return;
  syncStatus = status;
  for (const fn of statusListeners) fn(status);
}

export function subscribeRemoteSyncStatus(fn: (status: RemoteSyncStatus) => void): () => void {
  statusListeners.add(fn);
  fn(syncStatus);
  return () => {
    statusListeners.delete(fn);
  };
}

export function notifyRemoteInvalidated(): void {
  for (const fn of invalidatedListeners) fn();
}

export function subscribeRemoteInvalidated(fn: () => void): () => void {
  invalidatedListeners.add(fn);
  return () => {
    invalidatedListeners.delete(fn);
  };
}
