import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export interface TranscriptLiveState {
  readonly streamingId: string | null;
  readonly streamingText: string;
  readonly streamingThinking: string;
  readonly committedLen: number;
}

const initial: TranscriptLiveState = {
  streamingId: null,
  streamingText: "",
  streamingThinking: "",
  committedLen: 0,
};

export const transcriptLiveStore: Store<TranscriptLiveState> =
  makeStore<TranscriptLiveState>(initial);

type StreamingTextUpdate = string | ((prev: string) => string);

export const transcriptLiveActions = {
  setStreamingId(id: string | null): void {
    transcriptLiveStore.setState((prev) =>
      prev.streamingId === id ? prev : { ...prev, streamingId: id },
    );
  },
  setStreamingText(update: StreamingTextUpdate): void {
    transcriptLiveStore.setState((prev) => {
      const next = typeof update === "function" ? update(prev.streamingText) : update;
      return prev.streamingText === next ? prev : { ...prev, streamingText: next };
    });
  },
  setStreamingThinking(update: StreamingTextUpdate): void {
    transcriptLiveStore.setState((prev) => {
      const next = typeof update === "function" ? update(prev.streamingThinking) : update;
      return prev.streamingThinking === next ? prev : { ...prev, streamingThinking: next };
    });
  },
  setCommittedLen(updater: (prev: number) => number): void {
    transcriptLiveStore.setState((prev) => {
      const next = updater(prev.committedLen);
      return prev.committedLen === next ? prev : { ...prev, committedLen: next };
    });
  },
  reset(): void {
    transcriptLiveStore.setState((prev) =>
      prev.streamingId === null &&
      prev.streamingText === "" &&
      prev.streamingThinking === "" &&
      prev.committedLen === 0
        ? prev
        : initial,
    );
  },
};
