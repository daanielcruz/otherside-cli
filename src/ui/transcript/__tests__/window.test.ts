import { afterEach, describe, expect, it } from "bun:test";
import { getTranscriptEntries, transcriptActions } from "@/store/transcript/index.ts";
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

afterEach(() => transcriptActions.clear());

describe("transcript display window", () => {
  it("caps the very first projection to the tail window", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    const initial = entries(0, 1000);

    const displayed = transcriptWindowForDisplay(
      initial,
      anchorRef,
      TRANSCRIPT_RENDER_CAP,
      TRANSCRIPT_CAP_STEP,
    );

    expect(displayed[0]?.id).toBe("e800");
    expect(displayed).toHaveLength(TRANSCRIPT_RENDER_CAP);
    expect(displayed.some((entry) => entry.text.includes("earlier messages hidden"))).toBe(false);
    expect(displayed.at(-1)?.id).toBe("e999");
    expect(anchorRef.current).toEqual({ id: "e800", idx: 800 });
  });

  it("keeps a short history fully mounted", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    const short = entries(0, TRANSCRIPT_RENDER_CAP + TRANSCRIPT_CAP_STEP);

    const displayed = transcriptWindowForDisplay(short, anchorRef);

    expect(displayed).toBe(short);
    expect(anchorRef.current).toEqual({ id: "e0", idx: 0 });
  });

  it("advances the window by the hysteresis step, not per append", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    transcriptWindowForDisplay(entries(0, 1000), anchorRef);
    const anchorAfterBoot = anchorRef.current;

    // Appends inside the hysteresis band keep the anchor put.
    transcriptWindowForDisplay(entries(0, 1000 + TRANSCRIPT_CAP_STEP), anchorRef);
    expect(anchorRef.current).toEqual(anchorAfterBoot);

    // Crossing the band snaps the window back to the tail cap.
    const displayed = transcriptWindowForDisplay(entries(0, 1001 + TRANSCRIPT_CAP_STEP), anchorRef);
    expect(displayed[0]?.id).toBe(`e${801 + TRANSCRIPT_CAP_STEP}`);
    expect(displayed).toHaveLength(TRANSCRIPT_RENDER_CAP);
    expect(displayed.some((entry) => entry.text.includes("earlier messages hidden"))).toBe(false);
    expect(displayed.at(-1)?.id).toBe(`e${1000 + TRANSCRIPT_CAP_STEP}`);
  });

  it("keeps the tail cap when a rebuilt surface replaces the anchored entries", () => {
    const anchorRef = {
      current: null as Parameters<typeof transcriptWindowForDisplay>[1]["current"],
    };
    transcriptWindowForDisplay(entries(0, 300), anchorRef);

    const resumed: TranscriptEntry[] = entries(0, 1000).map((entry) => ({
      ...entry,
      id: `resumed_${entry.id}`,
    }));
    const displayed = transcriptWindowForDisplay(resumed, anchorRef);

    expect(displayed[0]?.id).toBe("resumed_e800");
    expect(displayed).toHaveLength(TRANSCRIPT_RENDER_CAP);
    expect(displayed.some((entry) => entry.text.includes("earlier messages hidden"))).toBe(false);
    expect(displayed.at(-1)?.id).toBe("resumed_e999");
    expect(anchorRef.current).toEqual({ id: "resumed_e800", idx: 800 });
  });
});

describe("transcript store history retention", () => {
  it("retains entries beyond the mounted window in the store", () => {
    transcriptActions.replace(entries(0, 1000));
    transcriptActions.update((prev) => [...prev, ...entries(1000, 1005)]);

    expect(getTranscriptEntries()).toHaveLength(1005);
    expect(getTranscriptEntries()[0]?.id).toBe("e0");
    expect(getTranscriptEntries().at(-1)?.id).toBe("e1004");
  });
});
