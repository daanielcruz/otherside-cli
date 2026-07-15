import { useEffect } from "react";
import { isSessionAlive } from "@/engine/session/registry.ts";
import { setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import { cleanupStaleImageCaches } from "@/kernel/storage/paste-image-cache.ts";

export function useImageCacheLifecycle(sessionId: string, pasteStore: PasteStore): void {
  useEffect(() => {
    cleanupStaleImageCaches(sessionId, isSessionAlive);
    setActivePasteStore(pasteStore);
    return () => setActivePasteStore(null);
  }, [sessionId, pasteStore]);
}
