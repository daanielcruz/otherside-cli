import { beforeEach, describe, expect, it } from "bun:test";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { appStore } from "@/store/app-store/index.ts";
import { getTranscriptEntries, getTranscriptFlushCursor, transcriptActions } from "../index.ts";

function entry(id: number): TranscriptEntry {
  return { id: `e${id}`, kind: "assistant", text: `t${id}` };
}

describe("transcript store history retention", () => {
  beforeEach(() => transcriptActions.clear());

  it("retains every resumed entry", () => {
    const all = Array.from({ length: 1500 }, (_, i) => entry(i));
    transcriptActions.replace(all);
    const kept = getTranscriptEntries();
    expect(kept).toHaveLength(1500);
    expect(kept[0]?.id).toBe("e0");
    expect(kept.at(-1)?.id).toBe("e1499");
  });

  it("retains earlier entries during append-style growth", () => {
    for (let i = 0; i < 1500; i++) {
      transcriptActions.update((prev) => [...prev, entry(i)]);
    }
    const kept = getTranscriptEntries();
    expect(kept).toHaveLength(1500);
    expect(kept[0]?.id).toBe("e0");
    expect(kept.at(-1)?.id).toBe("e1499");
  });

  it("preserves the array reference on a no-op update (no spurious re-render)", () => {
    transcriptActions.replace([entry(1), entry(2)]);
    const before = getTranscriptEntries();
    transcriptActions.update((prev) => prev); // identity
    expect(getTranscriptEntries()).toBe(before);
  });

  it("leaves under-cap entries untouched", () => {
    const few = [entry(1), entry(2), entry(3)];
    transcriptActions.replace(few);
    expect(getTranscriptEntries()).toEqual(few);
  });
});

describe("transcript store static flush cursor", () => {
  beforeEach(() => transcriptActions.clear());

  it("keeps the cursor in the store so remounts do not re-flush", () => {
    transcriptActions.replace([entry(1), entry(2)]);
    transcriptActions.markFlushedUpTo("e2");

    expect(getTranscriptFlushCursor()).toBe("e2");
    expect(getTranscriptEntries().map((item) => item.id)).toEqual(["e1", "e2"]);
  });

  it("resets the cursor for clear and replace paths used by clear and rewind", () => {
    transcriptActions.replace([entry(1), entry(2), entry(3)]);
    transcriptActions.markFlushedUpTo("e2");

    transcriptActions.clear();
    expect(getTranscriptFlushCursor()).toBeNull();

    transcriptActions.replace([entry(1), entry(2), entry(3)]);
    transcriptActions.markFlushedUpTo("e2");
    transcriptActions.replace([entry(1)]);
    expect(getTranscriptFlushCursor()).toBeNull();
  });

  it("keeps the cursor when appending after a flushed prefix", () => {
    transcriptActions.replace(Array.from({ length: 1000 }, (_, i) => entry(i)));
    transcriptActions.markFlushedUpTo("e0");
    transcriptActions.update((prev) => [...prev, entry(1000)]);

    expect(getTranscriptEntries()[0]?.id).toBe("e0");
    expect(getTranscriptFlushCursor()).toBe("e0");
  });

  it("invalidates the render surface if an already-flushed entry changes", () => {
    const beforeEpoch = appStore.getState().view.logEpoch;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      transcriptActions.replace([entry(1), entry(2)]);
      transcriptActions.markFlushedUpTo("e1");

      transcriptActions.update((prev) =>
        prev.map((item) => (item.id === "e1" ? { ...item, text: "changed" } : item)),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    expect(getTranscriptEntries()[0]?.text).toBe("changed");
    expect(getTranscriptFlushCursor()).toBeNull();
    expect(appStore.getState().view.logEpoch).toBe(beforeEpoch + 1);
  });
});

describe("transcript store per-entry text cap", () => {
  beforeEach(() => transcriptActions.clear());

  it("clips a pathologically large entry text, keeping the head + a notice", () => {
    const big = "x".repeat(600_000);
    transcriptActions.replace([{ id: "big", kind: "tool", text: big }]);
    const got = getTranscriptEntries()[0];
    expect(got?.text.length).toBeLessThan(big.length);
    expect(got?.text.startsWith("xxxx")).toBe(true);
    expect(got?.text.endsWith("full content in the session file]")).toBe(true);
  });

  it("clips a huge input field too", () => {
    transcriptActions.replace([{ id: "t", kind: "tool", text: "ok", input: "y".repeat(600_000) }]);
    expect(getTranscriptEntries()[0]?.input?.length ?? 0).toBeLessThan(600_000);
  });

  it("keeps the TAIL of an oversized live stream", () => {
    const live = `${"a".repeat(300_000)}${"b".repeat(300_000)}`;
    transcriptActions.replace([{ id: "l", kind: "tool", text: "ok", liveOutput: live }]);
    const lo = getTranscriptEntries()[0]?.liveOutput ?? "";
    expect(lo.length).toBeLessThan(live.length);
    expect(lo.endsWith("bbbb")).toBe(true);
  });

  it("leaves a large-but-under-cap entry exactly as-is (no clip, identity preserved)", () => {
    const entries = [{ id: "u", kind: "tool" as const, text: "z".repeat(100_000) }];
    transcriptActions.replace(entries);
    expect(getTranscriptEntries()[0]?.text.length).toBe(100_000);
  });

  it("does not re-clip an already-clipped entry (identity preserved after clip)", () => {
    // The clip must land at-or-under the threshold; otherwise the entry stays
    // flagged oversized and every later mutation re-maps the array (new ref →
    // spurious re-render + repeated giant slices).
    transcriptActions.replace([{ id: "big", kind: "tool", text: "x".repeat(600_000) }]);
    const afterClip = getTranscriptEntries();
    transcriptActions.update((prev) => prev); // identity no-op
    expect(getTranscriptEntries()).toBe(afterClip); // same array ref
    expect(getTranscriptEntries()[0]).toBe(afterClip[0]); // same entry ref
  });
});
