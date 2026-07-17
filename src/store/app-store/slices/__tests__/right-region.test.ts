import { describe, expect, it } from "bun:test";
import {
  initialRightRegionSlice,
  type RightRegionSlice,
  rightRegionReducer,
  selectRightRegionView,
} from "@/store/app-store/slices/right-region.ts";

function reduce(state: RightRegionSlice, action: Parameters<typeof rightRegionReducer>[1]) {
  return rightRegionReducer(state, action);
}

describe("rightRegionReducer", () => {
  it("shows a single ephemeral and queues a second until expiry (FIFO)", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "a", text: "A", priority: "medium", durationMs: 8_000 },
      now: 1_000,
    });
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "b", text: "B", priority: "medium", durationMs: 8_000 },
      now: 1_500,
    });

    expect(state.ephemeralCurrent?.key).toBe("a");
    expect(state.ephemeralCurrent?.expiresAt).toBe(9_000);
    expect(state.ephemeralQueue.map((n) => n.key)).toEqual(["b"]);
    expect(selectRightRegionView(state, 1_500).segments.map((s) => s.text)).toEqual(["A"]);

    state = reduce(state, { type: "rightRegion/expireCurrent", now: 9_000 });
    expect(state.ephemeralCurrent?.key).toBe("b");
    expect(state.ephemeralCurrent?.expiresAt).toBe(17_000);
    expect(state.ephemeralQueue).toEqual([]);
  });

  it("immediate preempts and requeues the previous notice with remaining time", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "slow", text: "slow", priority: "high", durationMs: 10_000 },
      now: 0,
    });
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "fast", text: "fast", priority: "immediate", durationMs: 2_000 },
      now: 4_000,
    });

    expect(state.ephemeralCurrent?.key).toBe("fast");
    expect(state.ephemeralCurrent?.expiresAt).toBe(6_000);
    expect(state.ephemeralQueue).toHaveLength(1);
    expect(state.ephemeralQueue[0]?.key).toBe("slow");
    expect(state.ephemeralQueue[0]?.remainingMs).toBe(6_000);
    expect(state.ephemeralQueue[0]?.expiresAt).toBeNull();

    state = reduce(state, { type: "rightRegion/expireCurrent", now: 6_000 });
    expect(state.ephemeralCurrent?.key).toBe("slow");
    expect(state.ephemeralCurrent?.expiresAt).toBe(12_000);
  });

  it("priority beats FIFO when promoting from the queue", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "holder", text: "holder", priority: "immediate", durationMs: 1_000 },
      now: 0,
    });
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "low", text: "low", priority: "low", durationMs: 5_000 },
      now: 10,
    });
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "high", text: "high", priority: "high", durationMs: 5_000 },
      now: 20,
    });
    state = reduce(state, { type: "rightRegion/expireCurrent", now: 1_000 });
    expect(state.ephemeralCurrent?.key).toBe("high");
  });

  it("dedupes same key unless fold is set", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "q", text: "one", durationMs: 8_000 },
      now: 0,
    });
    const again = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "q", text: "two", durationMs: 8_000 },
      now: 100,
    });
    expect(again).toBe(state);

    const folded = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "q", text: "two", durationMs: 8_000, fold: true },
      now: 100,
    });
    expect(folded.ephemeralCurrent?.text).toBe("two");
    // fold without restartOnFold preserves remaining time from original deadline
    expect(folded.ephemeralCurrent?.expiresAt).toBe(8_000);
  });

  it("honors cooldown windows", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "quota", text: "q1", durationMs: 1_000, cooldownMs: 120_000 },
      now: 0,
    });
    state = reduce(state, { type: "rightRegion/expireCurrent", now: 1_000 });
    const blocked = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "quota", text: "q2", durationMs: 1_000, cooldownMs: 120_000 },
      now: 50_000,
    });
    expect(blocked.ephemeralCurrent).toBeNull();

    const allowed = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "quota", text: "q2", durationMs: 1_000, cooldownMs: 120_000 },
      now: 120_000,
    });
    expect(allowed.ephemeralCurrent?.text).toBe("q2");
  });

  it("pauses remaining time off-viewport and resumes it", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "a", text: "A", durationMs: 8_000 },
      now: 0,
    });
    state = reduce(state, { type: "rightRegion/setPaused", paused: true, now: 3_000 });
    expect(state.paused).toBe(true);
    expect(state.ephemeralCurrent?.expiresAt).toBeNull();
    expect(state.ephemeralCurrent?.remainingMs).toBe(5_000);

    // Expiry is a no-op while paused.
    const still = reduce(state, { type: "rightRegion/expireCurrent", now: 100_000 });
    expect(still.ephemeralCurrent?.key).toBe("a");

    state = reduce(state, { type: "rightRegion/setPaused", paused: false, now: 10_000 });
    expect(state.ephemeralCurrent?.expiresAt).toBe(15_000);
    expect(state.ephemeralCurrent?.remainingMs).toBeNull();
  });

  it("persistent lane keeps counter alongside the highest-priority warning", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, { type: "rightRegion/setCounter", text: "1200 tokens" });
    state = reduce(state, {
      type: "rightRegion/upsertPersistent",
      notice: { key: "goal", text: "goal: ship", priority: "low", tone: "primary" },
      now: 0,
    });
    state = reduce(state, {
      type: "rightRegion/upsertPersistent",
      notice: {
        key: "auto-compact",
        text: "12% until auto-compact",
        priority: "high",
        tone: "warning",
      },
      now: 1,
    });

    const view = selectRightRegionView(state, 1);
    expect(view.mode).toBe("persistent");
    expect(view.segments.map((s) => s.key)).toEqual(["auto-compact", "tokens"]);
    expect(view.segments.map((s) => s.text)).toEqual(["12% until auto-compact", "1200 tokens"]);
  });

  it("ephemeral solo hides the persistent+counter lane", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, { type: "rightRegion/setCounter", text: "99 tokens" });
    state = reduce(state, {
      type: "rightRegion/upsertPersistent",
      notice: { key: "goal", text: "goal", priority: "medium" },
      now: 0,
    });
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: { key: "warn", text: "quota!", priority: "high", durationMs: 8_000 },
      now: 0,
    });
    const view = selectRightRegionView(state, 0);
    expect(view.mode).toBe("ephemeral");
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]?.text).toBe("quota!");
  });

  it("manual-duration notices require removeNotice", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/submitEphemeral",
      notice: {
        key: "voice-recording",
        text: "listening…",
        priority: "immediate",
        durationMs: null,
      },
      now: 0,
    });
    expect(state.ephemeralCurrent?.expiresAt).toBeNull();
    const afterExpire = reduce(state, { type: "rightRegion/expireCurrent", now: 50_000 });
    expect(afterExpire.ephemeralCurrent?.key).toBe("voice-recording");

    state = reduce(state, {
      type: "rightRegion/removeNotice",
      key: "voice-recording",
      now: 50_000,
    });
    expect(state.ephemeralCurrent).toBeNull();
  });

  it("tickRefresh bumps generation when a persistent refresh is due", () => {
    let state = initialRightRegionSlice;
    state = reduce(state, {
      type: "rightRegion/upsertPersistent",
      notice: { key: "goal", text: "goal", refreshEveryMs: 60_000 },
      now: 0,
    });
    const early = reduce(state, { type: "rightRegion/tickRefresh", now: 30_000 });
    expect(early.refreshGeneration).toBe(0);
    const due = reduce(state, { type: "rightRegion/tickRefresh", now: 60_000 });
    expect(due.refreshGeneration).toBe(1);
  });
});
