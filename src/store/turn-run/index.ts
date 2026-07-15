import type { MutableRefObject } from "react";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export type RunSubmittedTurn = (
  text: string,
  opts?: {
    blocks?: ContentBlock[];
    additionalContext?: string[];
    suppressUserTranscript?: boolean;
    isRemote?: boolean;
    restoreEntryId?: string;
  },
) => Promise<void>;

export type OnSubmit = (text: string) => Promise<void>;

// Live-turn lifecycle handles. Owned here (module singletons) so the render
// root, the dispatch loop, and the turn/session controllers share one source of
// truth for the running turn without threading refs through props. The app
// mounts once, so a module-level handle is equivalent to a per-mount ref.
export const runningRef: MutableRefObject<boolean> = { current: false };
export const generatorActiveRef: MutableRefObject<boolean> = { current: false };
export const compactRunningRef: MutableRefObject<boolean> = { current: false };
export const turnStartedAtRef: MutableRefObject<number | null> = { current: null };
export const turnSeedRef: MutableRefObject<number> = { current: 0 };
export const freezeObserverRef: MutableRefObject<(() => void) | null> = { current: null };
export const skillAbortRef: MutableRefObject<AbortController | null> = { current: null };
export const runSubmittedTurnRef: MutableRefObject<RunSubmittedTurn> = {
  current: async () => {},
};
export const onSubmitRef: MutableRefObject<OnSubmit | null> = { current: null };
// Mirrors runSubmittedTurnRef: the background-resume driver is created before
// handleSlash in createDispatchLoop, so it reads the live handler through this
// ref rather than a value captured at construction time.
export const handleSlashRef: MutableRefObject<(rawText: string) => boolean> = {
  current: () => false,
};
