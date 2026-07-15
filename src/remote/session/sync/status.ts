import {
  getRemoteSyncStatus,
  notifyRemoteInvalidated as publishRemoteInvalidated,
  setRemoteSyncStatus,
  subscribeRemoteInvalidated,
  subscribeRemoteSyncStatus,
} from "@/kernel/channels/remote-sync.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import { syncPeersWithBackend } from "@/remote/devices/peers.ts";

export type { RemoteSyncStatus };
export { getRemoteSyncStatus, subscribeRemoteInvalidated, subscribeRemoteSyncStatus };

export function notifyRemoteInvalidated(): void {
  publishRemoteInvalidated();
}

export function markRemoteUnauthorized(status: number): void {
  setSyncStatus("disconnected");
  if (status === 403) {
    void syncPeersWithBackend()
      .then(notifyRemoteInvalidated)
      .catch(() => {});
  }
}

export function setSyncStatus(status: RemoteSyncStatus): void {
  setRemoteSyncStatus(status);
}
