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

// ponytail: hard cap on retained render entries. This store is a pure render
// cache (rebuilt from the on-disk session file on resume); the display window
// already shows "… N earlier messages hidden (full history in the session
// file)". Uncapped, it grows for the whole session and pins every
// tool-result/assistant/agent-output string in JSC bmalloc — no compaction
// path trims it (compaction only splices session.messages[]/records[]). The cap
// sits far above the 200-entry render window so scrollback/rewind are unaffected;
// beyond it the on-disk session file is the source of truth.
// Both dimensions are bounded: entry COUNT here, and per-entry text below
// (MAX_ENTRY_TEXT_CHARS), so neither a long session nor a few giant entries can
// grow the cache without bound.
// Tunable via OTHERSIDE_MAX_TRANSCRIPT_ENTRIES (positive integer) for low-memory
// sessions and for render tests that must exercise the cap without staging 1000+
// entries; any unset / non-positive / non-integer value keeps the 1000 default,
// so the memory-leak bound is unchanged in normal use.
const MAX_RETAINED_ENTRIES = ((): number => {
  const raw = Number(process.env.OTHERSIDE_MAX_TRANSCRIPT_ENTRIES);
  return Number.isInteger(raw) && raw > 0 ? raw : 1000;
})();

// Per-entry text ceiling — the only unbounded dimension left once the COUNT is
// capped. A single pathological entry (a huge tool result the render path never
// pre-capped, or a stale entry whose record was later shrunk by
// applyToolResultBudget without this cache being told) would otherwise pin
// arbitrary bytes in the render cache. Clip far above any normal rendered entry
// (the largest Read/Bash preview); the full content always lives in the on-disk
// session file. Gated on `String.length` (O(1)) so the scan stays cheap.
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

function capTail(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return entries.length > MAX_RETAINED_ENTRIES
    ? entries.slice(entries.length - MAX_RETAINED_ENTRIES)
    : entries;
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

// Count of entries dropped from the FRONT by capTail over the store's life. The
// render window derives its "N earlier messages hidden" notice from
// droppedCount + sliceStart, NOT from sliceStart alone. Without this, each
// front-drop shifts every entry's absolute index down by one, so the notice
// count changes on every append once the store is at the cap — that changes the
// topmost (above-the-fold) row and forces a full terminal repaint per paint
// (the same shape as the count-based-slice scroll bug the render window already
// guards against with its anchor). droppedCount + sliceStart cancels the shift:
// each front-drop increments droppedCount by one and decrements sliceStart by
// one, keeping the rendered notice byte-stable.
let droppedCount = 0;

export function getDroppedTranscriptCount(): number {
  return droppedCount;
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
      if (produced.length > MAX_RETAINED_ENTRIES) {
        droppedCount += produced.length - MAX_RETAINED_ENTRIES;
      }
      const nextEntries = clipOversized(capTail(produced));
      const nextFlushedUpTo = invalidated
        ? null
        : cursorStillPresent(nextEntries, prev.flushedUpTo);
      return nextEntries === prev.entries && nextFlushedUpTo === prev.flushedUpTo
        ? prev
        : { entries: nextEntries, flushedUpTo: nextFlushedUpTo };
    });
  },
  replace(entries: readonly TranscriptEntry[]): void {
    const capped = clipOversized(capTail(entries));
    droppedCount = Math.max(0, entries.length - MAX_RETAINED_ENTRIES);
    transcriptStore.setState((prev) =>
      prev.entries === capped && prev.flushedUpTo === null
        ? prev
        : { entries: capped, flushedUpTo: null },
    );
  },
  clear(): void {
    droppedCount = 0;
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
