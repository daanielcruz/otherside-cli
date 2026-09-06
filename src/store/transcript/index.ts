import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";
export interface TranscriptState {
  readonly entries: readonly TranscriptEntry[];
}

const initial: TranscriptState = { entries: [] };

export const transcriptStore: Store<TranscriptState> = makeStore<TranscriptState>(initial);

// A single pathological entry (a huge tool result the render path never
// pre-capped, or a stale entry whose record was later shrunk by
// applyToolOutputBudget without this cache being told) can pin arbitrary bytes.
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

function preserveNoopUpdateIdentity(
  current: readonly TranscriptEntry[],
  updaterInput: readonly TranscriptEntry[],
  produced: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  if (produced !== updaterInput) return produced;
  if (
    produced.length === current.length &&
    produced.every((entry, index) => entry === current[index])
  ) {
    return current;
  }
  return produced;
}

export function getTranscriptEntries(): readonly TranscriptEntry[] {
  return transcriptStore.getState().entries;
}

type TranscriptUpdater = (prev: readonly TranscriptEntry[]) => readonly TranscriptEntry[];

export const transcriptActions = {
  appendProvisional(entry: TranscriptEntry): void {
    transcriptActions.update((entries) => [
      ...entries,
      { ...entry, settlementState: "provisional" },
    ]);
  },
  replaceMutable(recordId: string, update: (entry: TranscriptEntry) => TranscriptEntry): void {
    transcriptActions.update((entries) =>
      entries.map((entry) =>
        entry.id === recordId ? { ...update(entry), settlementState: "mutable-live" } : entry,
      ),
    );
  },
  settle(entry: TranscriptEntry): void {
    const settled = { ...entry, settlementState: "settled" as const };
    transcriptActions.update((entries) => {
      const existing = entries.find((candidate) => candidate.id === settled.id);
      if (existing === undefined) return [...entries, settled];
      return entries.map((candidate) => (candidate.id === settled.id ? settled : candidate));
    });
  },
  update(updater: TranscriptUpdater): void {
    transcriptStore.setState((prev) => {
      const updaterInput = [...prev.entries];
      const produced = preserveNoopUpdateIdentity(
        prev.entries,
        updaterInput,
        updater(updaterInput),
      );
      const nextEntries = clipOversized(produced);
      return nextEntries === prev.entries ? prev : { entries: nextEntries };
    });
  },
  replace(entries: readonly TranscriptEntry[]): void {
    transcriptStore.setState(() => ({ entries: clipOversized(entries) }));
  },
  clear(): void {
    transcriptStore.setState(() => initial);
  },
};
