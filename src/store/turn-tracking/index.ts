import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";

// Per-turn transcript + agent-call bookkeeping. These handles track the live
// turn's assistant/agent output routing and are read/written by the turn
// observer and the dispatch loop. Owned here as module singletons (the app
// mounts once) so both sides share the same state.
export const transcriptSeqRef: MutableRef<number> = { current: 0 };
export const currentAgentCallIdRef: MutableRef<string | null> = { current: null };
export const forkToCallIdRef: MutableRef<Map<string, string>> = { current: new Map() };
export const agentModelByCallIdRef: MutableRef<Map<string, ProviderModelRoute>> = {
  current: new Map(),
};
export const activeToolsRef: MutableRef<number> = { current: 0 };
export const forkActionRef: MutableRef<
  Map<string, { count: number; lastLabel: string; backgrounded: boolean }>
> = { current: new Map() };
export const turnHadVisibleOutputRef: MutableRef<boolean> = { current: false };
export const currentTurnPromptRef: MutableRef<string | null> = { current: null };
export const currentTurnUserIdRef: MutableRef<string | null> = { current: null };
export const routeForkEventRef: MutableRef<(event: ForkEvent) => void> = {
  current: () => {},
};

export function nextTranscriptId(prefix: string): string {
  const id = `${prefix}_${transcriptSeqRef.current}`;
  transcriptSeqRef.current += 1;
  return id;
}
