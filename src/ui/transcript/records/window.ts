import type { TranscriptEntry } from "@/ui/transcript/types";

export const TRANSCRIPT_RENDER_CAP = 200;
export const TRANSCRIPT_CAP_STEP = 50;

export type TranscriptSliceAnchor = {
  id: string;
  idx: number;
} | null;

// Tail cap with hysteresis: the mounted window always holds at most
// cap + step entries, on every projection — including the very first one
// after a resume, clear, or rewind. History beyond the window is never
// painted at boot; it stays in the session file (and in the full entry
// array) and is reachable on demand. An anchor whose entry vanished keeps
// its previous index so an in-place surface rebuild does not jump the
// window.
export function computeTranscriptSliceStart(
  entries: ReadonlyArray<TranscriptEntry>,
  anchorRef: { current: TranscriptSliceAnchor },
  cap = TRANSCRIPT_RENDER_CAP,
  step = TRANSCRIPT_CAP_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor
    ? entries[anchor.idx]?.id === anchor.id
      ? anchor.idx
      : entries.findIndex((entry) => entry.id === anchor.id)
    : -1;
  let start = anchorIdx >= 0 ? anchorIdx : anchor && anchor.idx < entries.length ? anchor.idx : 0;
  if (entries.length - start > cap + step) {
    start = entries.length - cap;
  }
  const entryAtStart = entries[start];
  if (entryAtStart && (anchor?.id !== entryAtStart.id || anchor.idx !== start)) {
    anchorRef.current = { id: entryAtStart.id, idx: start };
  } else if (!entryAtStart && anchor) {
    anchorRef.current = null;
  }
  return start;
}

export function transcriptWindowForDisplay(
  entries: readonly TranscriptEntry[],
  anchorRef: { current: TranscriptSliceAnchor },
  cap = TRANSCRIPT_RENDER_CAP,
  step = TRANSCRIPT_CAP_STEP,
): readonly TranscriptEntry[] {
  const start = computeTranscriptSliceStart(entries, anchorRef, cap, step);
  if (start <= 0) return entries;
  return entries.slice(start);
}
