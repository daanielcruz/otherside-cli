import type { SetStateAction } from "react";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface PostTurnDrainDeps {
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
}

export interface TurnContinuation {
  nextText: string | null;
  nextSuppress: boolean;
  nextRestoreEntryId: string | undefined;
}

export function createPostTurnDrain(deps: PostTurnDrainDeps): () => TurnContinuation {
  const { setTranscript } = deps;

  return () => {
    let nextText: string | null = null;
    let nextSuppress = false;
    let nextRestoreEntryId: string | undefined;
    const drained = getQueueMessages();
    if (drained.length > 0) {
      queueActions.clear();
      const slashEntries = drained.filter((q) => q.expanded.trim().startsWith("/"));
      const messageEntries = drained.filter((q) => !q.expanded.trim().startsWith("/"));
      const baseId = `qbnd_${Date.now()}`;
      setTranscript((t) => [
        ...t,
        ...messageEntries.map((q, i) => ({
          id: `${baseId}_${i}`,
          kind: "user" as const,
          text: q.expanded,
          ...(q.pastedImages && q.pastedImages.length > 0
            ? {
                images: q.pastedImages.map((img) => ({
                  id: img.id,
                  mediaType: img.mediaType,
                  ...(img.localPath ? { localPath: img.localPath } : {}),
                })),
              }
            : {}),
        })),
      ]);
      if (messageEntries.length > 0) {
        nextText = messageEntries.map((q) => q.expanded).join("\n\n");
        nextSuppress = true;
        nextRestoreEntryId = `${baseId}_0`;
        if (slashEntries.length > 0) {
          queueActions.replace(slashEntries);
        }
      } else if (slashEntries.length > 0) {
        const [first, ...rest] = slashEntries;
        if (rest.length > 0) {
          queueActions.replace(rest);
        }
        nextText = first?.expanded ?? null;
        nextSuppress = true;
      }
    }
    return { nextText, nextSuppress, nextRestoreEntryId };
  };
}
