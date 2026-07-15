import type { AgentEvent, ForkEvent } from "@/kernel/std/types/events.ts";

export interface ProgressState {
  responseChars: number;
  forkTokens: number;
  streamedToolIds: ReadonlySet<string>;
}

export const emptyProgressState = (): ProgressState => ({
  responseChars: 0,
  forkTokens: 0,
  streamedToolIds: new Set(),
});

export function progressTokensDown(state: ProgressState): number {
  return Math.round(state.responseChars / 4) + state.forkTokens;
}

function toolInputChars(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function applyAgentEventToProgress(state: ProgressState, ev: AgentEvent): ProgressState {
  if (ev.kind === "text_delta") {
    return { ...state, responseChars: state.responseChars + ev.text.length };
  }
  if (ev.kind === "thinking_delta") {
    return { ...state, responseChars: state.responseChars + ev.text.length };
  }
  if (ev.kind === "tool_call_input_delta") {
    const streamedToolIds = new Set(state.streamedToolIds).add(ev.id);
    return { ...state, responseChars: state.responseChars + ev.partial.length, streamedToolIds };
  }
  if (ev.kind === "tool_call_complete") {
    if (state.streamedToolIds.has(ev.id)) return state;
    return { ...state, responseChars: state.responseChars + toolInputChars(ev.input) };
  }
  if (ev.kind === "fork_usage") {
    if (ev.isSnapshot) return state;
    return { ...state, forkTokens: state.forkTokens + Math.max(0, ev.outputTokens) };
  }
  if (ev.kind === "stream_reset") {
    // The discarded attempt's streamed chars would inflate the live output
    // estimate on re-send; fork work is not voided by a main-stream reset.
    return { ...state, responseChars: 0, streamedToolIds: new Set() };
  }
  return state;
}

export function applyForkEventToProgress(state: ProgressState, ev: ForkEvent): ProgressState {
  if (ev.kind === "fork_text_delta") {
    return { ...state, forkTokens: state.forkTokens + Math.round(ev.text.length / 4) };
  }
  if (ev.kind === "fork_stream_reset") {
    return {
      ...state,
      forkTokens: Math.max(0, state.forkTokens - Math.round(ev.discardedChars / 4)),
    };
  }
  if (ev.kind === "fork_usage") {
    if (ev.isSnapshot) return state;
    return { ...state, forkTokens: state.forkTokens + Math.max(0, ev.outputTokens) };
  }
  return state;
}
