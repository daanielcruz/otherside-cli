import type { MutableRefObject } from "react";

// Runtime handles for the currently running "btw" side-turn: its abort
// controller, the session id it belongs to, and a monotonic sequence counter.
// The turn history itself lives in ./index.ts; these are the live-run handles
// shared by the render root and the btw controller.
export const btwAbortRef: MutableRefObject<AbortController | null> = { current: null };
export const btwSessionIdRef: MutableRefObject<string | null> = { current: null };
export const btwSeqRef: MutableRefObject<number> = { current: 0 };
