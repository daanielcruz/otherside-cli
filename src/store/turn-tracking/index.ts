import type { MutableRefObject } from "react";
import type { ForkEvent } from "@/kernel/std/types/events.ts";

// Per-turn transcript + agent-call bookkeeping. These handles track the live
// turn's assistant/agent output routing and are read/written by the turn
// observer and the dispatch loop. Owned here as module singletons (the app
// mounts once) so both sides share the same state.
export const transcriptSeqRef: MutableRefObject<number> = { current: 0 };
export const currentAgentCallIdRef: MutableRefObject<string | null> = { current: null };
export const forkToCallIdRef: MutableRefObject<Map<string, string>> = { current: new Map() };
export const agentModelByCallIdRef: MutableRefObject<Map<string, string>> = { current: new Map() };
export const activeToolsRef: MutableRefObject<number> = { current: 0 };
export const forkActionRef: MutableRefObject<
  Map<string, { count: number; lastLabel: string; backgrounded: boolean }>
> = { current: new Map() };
export const turnHadVisibleOutputRef: MutableRefObject<boolean> = { current: false };
export const currentTurnPromptRef: MutableRefObject<string | null> = { current: null };
export const currentTurnUserIdRef: MutableRefObject<string | null> = { current: null };
export const routeForkEventRef: MutableRefObject<(event: ForkEvent) => void> = {
  current: () => {},
};

export function nextTranscriptId(prefix: string): string {
  const id = `${prefix}_${transcriptSeqRef.current}`;
  transcriptSeqRef.current += 1;
  return id;
}
