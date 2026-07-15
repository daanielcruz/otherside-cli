import { describe, expect, it } from "bun:test";
import { formatGcDiagLine, shouldForceSweep } from "@/devtools/memory/gc-cadence.ts";

const MB = 1024 * 1024;
const OVER_THRESHOLD = 301 * MB;
const UNDER_THRESHOLD = 100 * MB;

describe("formatGcDiagLine", () => {
  it("emits a JSONL sample with MB-rounded fields and the forced flag", () => {
    const line = formatGcDiagLine({ rss: 500 * MB, heapUsed: 120 * MB }, 380 * MB, true, 1000);
    expect(JSON.parse(line)).toEqual({
      t: 1000,
      rss_mb: 500,
      heap_mb: 120,
      native_mb: 380,
      forced: true,
    });
  });

  it("records forced=false when native stays under the threshold", () => {
    const parsed = JSON.parse(
      formatGcDiagLine({ rss: 200 * MB, heapUsed: 120 * MB }, 80 * MB, false, 42),
    );
    expect(parsed.forced).toBe(false);
    expect(parsed.native_mb).toBe(80);
  });
});

describe("shouldForceSweep", () => {
  it("forces when over threshold, no recent activity, and out of the min gap", () => {
    const result = shouldForceSweep({
      nativeBytes: OVER_THRESHOLD,
      tick: 1,
      nowMs: 100_000,
      lastForcedAt: 0,
      lastActivityAt: 0,
    });
    expect(result).toBe(true);
  });

  it("stays quiet within FORCED_SWEEP_MIN_GAP_MS of the last forced sweep", () => {
    const result = shouldForceSweep({
      nativeBytes: OVER_THRESHOLD,
      tick: 1,
      nowMs: 10_000,
      lastForcedAt: 5_000, // 5s ago, gap is 10s
      lastActivityAt: Number.NEGATIVE_INFINITY,
    });
    expect(result).toBe(false);
  });

  it("defers when the proxy wants a sweep but activity was recent and it is not overdue", () => {
    const result = shouldForceSweep({
      nativeBytes: OVER_THRESHOLD,
      tick: 1,
      nowMs: 20_000,
      lastForcedAt: 0, // 20s since last force, past the 10s gap
      lastActivityAt: 19_000, // 1s ago, inside the 3s quiet window
    });
    expect(result).toBe(false);
  });

  it("overrides the typing defer once MAX_FORCED_DEFER_MS is reached", () => {
    const result = shouldForceSweep({
      nativeBytes: OVER_THRESHOLD,
      tick: 1,
      nowMs: 30_000,
      lastForcedAt: 0, // exactly 30s since last force: overdue
      lastActivityAt: 29_500, // still recent, typing is true
    });
    expect(result).toBe(true);
  });

  it("does not want a sweep when under threshold and tick is not a multiple of 30", () => {
    const result = shouldForceSweep({
      nativeBytes: UNDER_THRESHOLD,
      tick: 7,
      nowMs: 100_000,
      lastForcedAt: 0,
      lastActivityAt: 0,
    });
    expect(result).toBe(false);
  });

  it("wants a sweep on the unconditional cadence tick even under threshold", () => {
    const result = shouldForceSweep({
      nativeBytes: UNDER_THRESHOLD,
      tick: 30,
      nowMs: 100_000,
      lastForcedAt: 0,
      lastActivityAt: 0,
    });
    expect(result).toBe(true);
  });

  it("still gates the unconditional cadence tick behind the min gap", () => {
    const result = shouldForceSweep({
      nativeBytes: UNDER_THRESHOLD,
      tick: 30,
      nowMs: 5_000,
      lastForcedAt: 0, // only 5s ago, inside the 10s gap
      lastActivityAt: Number.NEGATIVE_INFINITY,
    });
    expect(result).toBe(false);
  });
});
