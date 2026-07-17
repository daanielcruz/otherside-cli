import { useEffect, useSyncExternalStore } from "react";
import {
  isActive as designSessionActive,
  subscribe as subscribeDesign,
} from "@/design/spawn-registry.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import {
  RightNoticeKey,
  removePersistent,
  upsertPersistent,
} from "@/store/app-store/right-region-notices.ts";

/**
 * Publishes remote + design session status into the persistent right-region lane.
 * When both are active, coalesces into a single notice (matches prior bar.tsx).
 */
export function useRightRegionSessionNotices(remoteSyncStatus: RemoteSyncStatus): void {
  const designActive = useSyncExternalStore(
    subscribeDesign,
    designSessionActive,
    designSessionActive,
  );

  useEffect(() => {
    const remoteShown = remoteSyncStatus !== "disconnected";
    const remoteActive = remoteSyncStatus === "active";

    if (remoteActive && designActive) {
      removePersistent(RightNoticeKey.remote);
      removePersistent(RightNoticeKey.design);
      upsertPersistent({
        key: RightNoticeKey.remoteDesign,
        text: "Remote & Design sessions active",
        tone: "success",
        priority: "high",
        bold: true,
      });
      return;
    }

    removePersistent(RightNoticeKey.remoteDesign);

    if (remoteShown) {
      upsertPersistent({
        key: RightNoticeKey.remote,
        text: remoteActive ? "Remote Session active" : "Remote Session connecting...",
        tone: remoteActive ? "success" : "warning",
        priority: "high",
        bold: true,
      });
    } else {
      removePersistent(RightNoticeKey.remote);
    }

    if (designActive) {
      upsertPersistent({
        key: RightNoticeKey.design,
        text: "Design session active",
        tone: "design",
        priority: "medium",
        bold: true,
      });
    } else {
      removePersistent(RightNoticeKey.design);
    }
  }, [remoteSyncStatus, designActive]);
}
