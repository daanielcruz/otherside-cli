import type React from "react";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import { transcriptActions, transcriptLiveActions, transcriptLiveStore } from "@/store/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface TranscriptSetters {
  setTranscript: (value: React.SetStateAction<readonly TranscriptEntry[]>) => void;
  setStreamingId: (value: string | null | ((prev: string | null) => string | null)) => void;
  setStreamingText: (value: string | ((prev: string) => string)) => void;
  setStreamingThinking: (value: string | ((prev: string) => string)) => void;
  setStreamingCommittedLen: (value: number | ((prev: number) => number)) => void;
}

export function createTranscriptSetters(transcriptBatch: MacrotaskBatch): TranscriptSetters {
  return {
    setTranscript: (value) => {
      transcriptBatch.enqueue(() => {
        if (typeof value === "function") {
          transcriptActions.update(value);
        } else {
          transcriptActions.replace(value);
        }
      });
    },
    setStreamingId: (value) => {
      transcriptBatch.enqueue(() => {
        const next =
          typeof value === "function" ? value(transcriptLiveStore.getState().streamingId) : value;
        transcriptLiveActions.setStreamingId(next);
      });
    },
    setStreamingText: (value) => {
      transcriptBatch.enqueue(() => {
        transcriptLiveActions.setStreamingText(value);
      });
    },
    setStreamingThinking: (value) => {
      transcriptBatch.enqueue(() => {
        transcriptLiveActions.setStreamingThinking(value);
      });
    },
    setStreamingCommittedLen: (value) => {
      transcriptBatch.enqueue(() => {
        transcriptLiveActions.setCommittedLen(typeof value === "function" ? value : () => value);
      });
    },
  };
}
