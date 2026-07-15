import { afterEach, describe, expect, it } from "bun:test";
import {
  getDroppedTranscriptCount,
  getTranscriptEntries,
  transcriptActions,
} from "@/store/transcript/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";
import {
  TRANSCRIPT_CAP_STEP,
  TRANSCRIPT_RENDER_CAP,
  transcriptWindowForDisplay,
} from "../records/window.ts";

function entries(from: number, to: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let n = from; n < to; n++) out.push({ id: `e${n}`, kind: "system", text: "" });
  return out;
}

function noticeHidden(window: readonly TranscriptEntry[]): number | null {
  const first = window[0];
  if (!first || first.id !== "transcript_cap_notice") return null;
  const m = first.text.match(/…\s*(\d+)\s*earlier/);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

afterEach(() => transcriptActions.clear());

describe("transcript cap-notice stability under capTail front-drop", () => {
  it("keeps the hidden count byte-stable across a front-drop append (priorHidden + start cancels the shift)", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    const dropped = 1500;
    const before = transcriptWindowForDisplay(
      entries(0, 1000),
      anchorRef,
      TRANSCRIPT_RENDER_CAP,
      TRANSCRIPT_CAP_STEP,
      dropped,
    );
    // capTail dropped e0 from the front and e1000 was appended → window shifts by 1
    const after = transcriptWindowForDisplay(
      entries(1, 1001),
      anchorRef,
      TRANSCRIPT_RENDER_CAP,
      TRANSCRIPT_CAP_STEP,
      dropped + 1,
    );
    expect(noticeHidden(before)).not.toBeNull();
    expect(noticeHidden(after)).toBe(noticeHidden(before));
  });

  it("WITHOUT the dropped-count accounting the notice shifts every append (the regression)", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    const before = transcriptWindowForDisplay(
      entries(0, 1000),
      anchorRef,
      TRANSCRIPT_RENDER_CAP,
      TRANSCRIPT_CAP_STEP,
      0,
    );
    const after = transcriptWindowForDisplay(
      entries(1, 1001),
      anchorRef,
      TRANSCRIPT_RENDER_CAP,
      TRANSCRIPT_CAP_STEP,
      0,
    );
    expect(noticeHidden(after)).not.toBe(noticeHidden(before));
  });
});

describe("transcript store droppedCount tracking", () => {
  it("counts entries dropped from the front by capTail and resets on clear/replace", () => {
    transcriptActions.clear();
    expect(getDroppedTranscriptCount()).toBe(0);

    transcriptActions.replace(entries(0, 1000));
    expect(getDroppedTranscriptCount()).toBe(0);
    expect(getTranscriptEntries().length).toBe(1000);

    transcriptActions.update((prev) => [...prev, ...entries(1000, 1005)]);
    expect(getDroppedTranscriptCount()).toBe(5);
    expect(getTranscriptEntries().length).toBe(1000);

    transcriptActions.replace(entries(0, 1002));
    expect(getDroppedTranscriptCount()).toBe(2);

    transcriptActions.clear();
    expect(getDroppedTranscriptCount()).toBe(0);
  });
});
