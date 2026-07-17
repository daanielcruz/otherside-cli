import { useSyncExternalStore } from "react";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";
import { dispatch } from "@/store/app-store/index.ts";

export interface TranscriptState {
  readonly entries: readonly TranscriptEntry[];
  readonly flushedUpTo: string | null;
}

const initial: TranscriptState = { entries: [], flushedUpTo: null };

export const transcriptStore: Store<TranscriptState> = makeStore<TranscriptState>(initial);

// A single pathological entry (a huge tool result the render path never
// pre-capped, or a stale entry whose record was later shrunk by
// applyToolResultBudget without this cache being told) can pin arbitrary bytes.
// Clip far above any normal rendered entry; the full content remains on disk.
// Gated on `String.length` (O(1)) so the scan stays cheap.
const MAX_ENTRY_TEXT_CHARS = 512 * 1024;
const ENTRY_CLIP_NOTICE = "\n[… clipped — full content in the session file]";

function clipHead(text: string): string {
  // Reserve room for the notice so the RESULT length is <= MAX_ENTRY_TEXT_CHARS;
  // otherwise the clipped entry stays over the threshold and re-clips on every
  // store mutation (new array ref → spurious re-renders + repeated 512 KB slices).
  return text.length > MAX_ENTRY_TEXT_CHARS
    ? text.slice(0, MAX_ENTRY_TEXT_CHARS - ENTRY_CLIP_NOTICE.length) + ENTRY_CLIP_NOTICE
    : text;
}

function entryOversized(entry: TranscriptEntry): boolean {
  return (
    entry.text.length > MAX_ENTRY_TEXT_CHARS ||
    (entry.input !== undefined && entry.input.length > MAX_ENTRY_TEXT_CHARS) ||
    (entry.liveOutput !== undefined && entry.liveOutput.length > MAX_ENTRY_TEXT_CHARS)
  );
}

function clipEntry(entry: TranscriptEntry): TranscriptEntry {
  if (!entryOversized(entry)) return entry;
  return {
    ...entry,
    text: clipHead(entry.text),
    ...(entry.input !== undefined ? { input: clipHead(entry.input) } : {}),
    // liveOutput is a tail-oriented stream; keep the most recent chars.
    ...(entry.liveOutput !== undefined
      ? { liveOutput: entry.liveOutput.slice(-MAX_ENTRY_TEXT_CHARS) }
      : {}),
  };
}

function clipOversized(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  let hasOversized = false;
  for (const entry of entries) {
    if (entryOversized(entry)) {
      hasOversized = true;
      break;
    }
  }
  return hasOversized ? entries.map(clipEntry) : entries;
}

function sameEntryForFlushGuard(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function flushedPrefixMutation(
  prevEntries: readonly TranscriptEntry[],
  producedEntries: readonly TranscriptEntry[],
  flushedUpTo: string | null,
): TranscriptEntry | null {
  if (flushedUpTo === null) return null;
  const cursorIndex = prevEntries.findIndex((entry) => entry.id === flushedUpTo);
  if (cursorIndex === -1) return null;
  for (let i = 0; i <= cursorIndex; i++) {
    const prev = prevEntries[i];
    const next = producedEntries[i];
    if (!prev) continue;
    if (!next || next.id !== prev.id || !sameEntryForFlushGuard(prev, next)) return prev;
  }
  return null;
}

function invalidateAfterFlushedMutation(entry: TranscriptEntry): boolean {
  const message = `transcript entry ${entry.id} changed after static flush`;
  if (process.env.NODE_ENV === "development") {
    throw new Error(message);
  }
  dispatch({ type: "view/bumpLogEpoch" });
  return true;
}

function cursorStillPresent(
  entries: readonly TranscriptEntry[],
  flushedUpTo: string | null,
): string | null {
  if (flushedUpTo === null) return null;
  return entries.some((entry) => entry.id === flushedUpTo) ? flushedUpTo : null;
}

export function getTranscriptEntries(): readonly TranscriptEntry[] {
  return transcriptStore.getState().entries;
}

export function getTranscriptFlushCursor(): string | null {
  return transcriptStore.getState().flushedUpTo;
}

type TranscriptUpdater = (prev: readonly TranscriptEntry[]) => readonly TranscriptEntry[];

export const transcriptActions = {
  update(updater: TranscriptUpdater): void {
    transcriptStore.setState((prev) => {
      const produced = updater(prev.entries);
      const mutation = flushedPrefixMutation(prev.entries, produced, prev.flushedUpTo);
      const invalidated = mutation !== null ? invalidateAfterFlushedMutation(mutation) : false;
      const nextEntries = clipOversized(produced);
      const nextFlushedUpTo = invalidated
        ? null
        : cursorStillPresent(nextEntries, prev.flushedUpTo);
      return nextEntries === prev.entries && nextFlushedUpTo === prev.flushedUpTo
        ? prev
        : { entries: nextEntries, flushedUpTo: nextFlushedUpTo };
    });
  },
  replace(entries: readonly TranscriptEntry[]): void {
    const retained = clipOversized(entries);
    transcriptStore.setState((prev) =>
      prev.entries === retained && prev.flushedUpTo === null
        ? prev
        : { entries: retained, flushedUpTo: null },
    );
  },
  clear(): void {
    transcriptStore.setState((prev) =>
      prev.entries.length === 0 && prev.flushedUpTo === null
        ? prev
        : { entries: [], flushedUpTo: null },
    );
  },
  markFlushedUpTo(id: string): void {
    transcriptStore.setState((prev) =>
      prev.flushedUpTo === id ? prev : { ...prev, flushedUpTo: id },
    );
  },
  resetFlushCursor(): void {
    transcriptStore.setState((prev) =>
      prev.flushedUpTo === null ? prev : { ...prev, flushedUpTo: null },
    );
  },
};

export function useTranscriptEntries(): readonly TranscriptEntry[] {
  return useSyncExternalStore(
    transcriptStore.subscribe,
    () => transcriptStore.getState().entries,
    () => transcriptStore.getState().entries,
  );
}
