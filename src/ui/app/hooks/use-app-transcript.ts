import { useMemo, useRef } from "react";
import { type MacrotaskBatch, makeMacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import { transcriptActions, useTranscriptEntries, useTranscriptLive } from "@/store/index.ts";
import {
  type TranscriptSliceAnchor,
  transcriptWindowForDisplay,
} from "@/ui/transcript/records/window.ts";
import { createTranscriptSetters } from "@/ui/transcript/stream/setters.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

const EMPTY_LIVE_ENTRIES: TranscriptEntry[] = [];

export interface AppTranscriptDeps {
  initialTranscript?: TranscriptEntry[] | undefined;
}

export function useAppTranscript(deps: AppTranscriptDeps) {
  const { initialTranscript } = deps;
  const seededTranscriptRef = useRef(false);
  if (!seededTranscriptRef.current) {
    seededTranscriptRef.current = true;
    if (initialTranscript && initialTranscript.length > 0) {
      transcriptActions.replace(initialTranscript);
    }
  }
  const transcript = useTranscriptEntries();
  const transcriptWindowAnchorRef = useRef<TranscriptSliceAnchor>(null);
  const displayTranscript = useMemo(
    () => transcriptWindowForDisplay(transcript, transcriptWindowAnchorRef),
    [transcript],
  );
  // Pass the display transcript urgently. A deferred value starves under the
  // frame-sync tick during turns; appends are already macrotask-batched and the
  // display list is render-capped.
  const {
    streamingId,
    streamingText,
    streamingThinking,
    committedLen: streamingCommittedLen,
  } = useTranscriptLive();
  const transcriptBatchRef = useRef<MacrotaskBatch | null>(null);
  if (transcriptBatchRef.current === null) transcriptBatchRef.current = makeMacrotaskBatch();
  const transcriptBatch = transcriptBatchRef.current;
  const transcriptSetters = useMemo(
    () => createTranscriptSetters(transcriptBatch),
    [transcriptBatch],
  );
  const liveEntries = useMemo<TranscriptEntry[]>(() => {
    if (streamingId === null) return EMPTY_LIVE_ENTRIES;
    const entries: TranscriptEntry[] = [];
    // Reasoning-only phase: show the in-flight thinking as a condensed live
    // row. It clears in the same batch that commits the thinking entry to the
    // transcript, so the handoff has no gap and no duplication.
    if (streamingThinking.trim().length > 0) {
      entries.push({
        id: `${streamingId}_lth`,
        kind: "thinking",
        text: streamingThinking,
        streaming: true,
      });
    }
    if (streamingText.length > 0) {
      const committed = Math.min(Math.max(0, streamingCommittedLen), streamingText.length);
      const tail = committed > 0 ? streamingText.slice(committed) : streamingText;
      if (tail.length > 0) {
        entries.push({
          id: streamingId,
          kind: "assistant",
          text: tail,
          streaming: true,
          ...(committed > 0 ? { continuation: true } : {}),
        });
      }
    }
    return entries.length > 0 ? entries : EMPTY_LIVE_ENTRIES;
  }, [streamingId, streamingText, streamingThinking, streamingCommittedLen]);

  return {
    transcript,
    displayTranscript,
    liveEntries,
    streamingId,
    streamingText,
    streamingThinking,
    streamingCommittedLen,
    transcriptBatch,
    ...transcriptSetters,
  };
}
