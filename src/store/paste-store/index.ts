import { formatPasteRef } from "@/kernel/std/paste/ref.ts";
import type { PastedContent, PasteStore } from "@/kernel/std/types/paste.ts";
import { persistPastedImage } from "@/kernel/storage/paste-image-cache.ts";

const MAX_STORED_IMAGE_PATHS = 200;

export function createPasteStore(sessionId: string): PasteStore {
  const map = new Map<number, PastedContent>();
  let nextId = 1;
  const evictOldestIfAtCap = (): void => {
    while (map.size >= MAX_STORED_IMAGE_PATHS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    add(item) {
      const id = nextId++;
      const stored: PastedContent = { id, ...item };
      if (item.type === "image" && item.mediaType && !stored.sourcePath) {
        const path = persistPastedImage({
          sessionId,
          id,
          base64: item.content,
          mediaType: item.mediaType,
        });
        if (path) stored.sourcePath = path;
      }
      evictOldestIfAtCap();
      map.set(id, stored);
      return { id, placeholder: formatPasteRef(item.type, id, item.content) };
    },
    get(id) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
    clear() {
      map.clear();
      nextId = 1;
    },
  };
}
