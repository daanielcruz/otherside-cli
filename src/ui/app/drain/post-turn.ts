import type { SetStateAction } from "react";
import type { PendingChange } from "@/commands/index.ts";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface PostTurnDrainDeps {
  applyPendingChange: (change: PendingChange) => void;
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
}

export interface TurnContinuation {
  nextText: string | null;
  nextSuppress: boolean;
  nextRestoreEntryId: string | undefined;
}

export function createPostTurnDrain(deps: PostTurnDrainDeps): () => TurnContinuation {
  const { applyPendingChange, setTranscript } = deps;

  return () => {
    let nextText: string | null = null;
    let nextSuppress = false;
    let nextRestoreEntryId: string | undefined;
    const drained = getQueueMessages();
    if (drained.length > 0) {
      queueActions.clear();
      const pendingFeedback: string[] = [];
      for (const q of drained) {
        if (q.pendingChange) {
          applyPendingChange(q.pendingChange);
          if (q.changeFeedback) pendingFeedback.push(q.changeFeedback);
        }
      }
      const drainedEntries = drained.filter((q) => !q.pendingChange);
      const slashEntries = drainedEntries.filter((q) => q.expanded.trim().startsWith("/"));
      const messageEntries = drainedEntries.filter((q) => !q.expanded.trim().startsWith("/"));
      const baseId = `qbnd_${Date.now()}`;
      setTranscript((t) => [
        ...t,
        ...pendingFeedback.map((feedback, i) => ({
          id: `${baseId}_change_${i}`,
          kind: "compact_done" as const,
          text: feedback,
          muted: true,
        })),
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
