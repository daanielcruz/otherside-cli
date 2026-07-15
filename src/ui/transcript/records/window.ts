import { getDroppedTranscriptCount } from "@/store/transcript/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export const TRANSCRIPT_RENDER_CAP = 200;
export const TRANSCRIPT_CAP_STEP = 50;

const TRANSCRIPT_CAP_NOTICE_ID = "transcript_cap_notice";

export type TranscriptSliceAnchor = {
  id: string;
  idx: number;
} | null;

export function computeTranscriptSliceStart(
  entries: ReadonlyArray<TranscriptEntry>,
  anchorRef: { current: TranscriptSliceAnchor },
  cap = TRANSCRIPT_RENDER_CAP,
  step = TRANSCRIPT_CAP_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor ? entries.findIndex((entry) => entry.id === anchor.id) : -1;
  let start =
    anchorIdx >= 0
      ? anchorIdx
      : anchor
        ? Math.min(anchor.idx, Math.max(0, entries.length - cap))
        : 0;
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
  priorHidden = getDroppedTranscriptCount(),
): readonly TranscriptEntry[] {
  const start = computeTranscriptSliceStart(entries, anchorRef, cap, step);
  // hidden = entries already dropped from the store front (priorHidden) + entries
  // before the window start (start). The two move in opposite directions on a
  // capTail front-drop, so the notice count stays byte-stable across appends —
  // the topmost above-the-fold row never changes, so no full terminal repaint.
  const hidden = priorHidden + start;
  if (hidden <= 0) return entries;
  return [makeTranscriptCapNotice(hidden), ...entries.slice(start)];
}

export function capTranscriptForDisplay(
  entries: readonly TranscriptEntry[],
  cap = TRANSCRIPT_RENDER_CAP,
): readonly TranscriptEntry[] {
  const anchorRef: { current: TranscriptSliceAnchor } = { current: null };
  return transcriptWindowForDisplay(entries, anchorRef, cap, 0);
}

function makeTranscriptCapNotice(hidden: number): TranscriptEntry {
  return {
    id: TRANSCRIPT_CAP_NOTICE_ID,
    kind: "system",
    text: `… ${hidden} earlier ${hidden === 1 ? "message" : "messages"} hidden (full history in the session file)`,
    muted: true,
  };
}
