import type { MutableRefObject } from "react";

// Per-turn error / quota gating flags. Reset at turn boundaries so a single
// turn shows at most one quota gutter / error panel and revokes its unanswered
// user message on the right failures. Owned here as module singletons shared by
// the render root and the dispatch loop.
export const quotaHandledForTurnRef: MutableRefObject<boolean> = { current: false };
export const errorPanelActiveForTurnRef: MutableRefObject<boolean> = { current: false };
export const pendingErrorRevokeRef: MutableRefObject<boolean> = { current: false };
export const compactTerminalRef: MutableRefObject<boolean> = { current: false };
