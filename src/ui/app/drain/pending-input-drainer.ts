import type { SetStateAction } from "react";
import type { PendingChange } from "@/commands/index.ts";
import { getQueueMessages, queueActions } from "@/store/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface PendingInputDrainerDeps {
  applyPendingChange: (change: PendingChange) => void;
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
  nextTranscriptId: (prefix: string) => string;
}

export function createPendingInputDrainer(deps: PendingInputDrainerDeps) {
  const { applyPendingChange, setTranscript, nextTranscriptId } = deps;

  return () => {
    const current = getQueueMessages();
    if (current.length === 0) return [];
    const pendingFeedback: string[] = [];
    for (const q of current) {
      if (q.pendingChange) {
        applyPendingChange(q.pendingChange);
        if (q.changeFeedback) pendingFeedback.push(q.changeFeedback);
      }
    }
    if (pendingFeedback.length > 0) {
      setTranscript((t) => [
        ...t,
        ...pendingFeedback.map((feedback, i) => ({
          id: nextTranscriptId(`queue_apply_${i}`),
          kind: "compact_done" as const,
          text: feedback,
          muted: true,
        })),
      ]);
    }
    const messageEntries = current.filter(
      (q) => !q.pendingChange && !q.expanded.trim().startsWith("/"),
    );
    const drained = messageEntries.map((q) => ({
      text: q.expanded,
      blocks: q.blocks ?? [{ type: "text" as const, text: q.expanded }],
      ...(q.pastedImages && q.pastedImages.length > 0 ? { pastedImages: q.pastedImages } : {}),
      ...(q.remotePayload ? { remotePayload: q.remotePayload } : {}),
    }));
    const keptSlashEntries = current.filter(
      (q) => !q.pendingChange && q.expanded.trim().startsWith("/"),
    );
    queueActions.replace(keptSlashEntries);
    return drained;
  };
}
