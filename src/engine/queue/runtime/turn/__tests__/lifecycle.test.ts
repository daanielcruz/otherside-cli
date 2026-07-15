import { describe, expect, it } from "bun:test";
import { createTurnLifecycle } from "../lifecycle.ts";

function makeDeps() {
  return {
    runningRef: { current: false },
    generatorActiveRef: { current: false },
    compactRunningRef: { current: false },
    turnStartedAtRef: { current: null } as { current: number | null },
    setBusy: () => {},
    setProgressStartedAt: () => {},
    setLiveOutputTokens: () => {},
  };
}

describe("createTurnLifecycle — turnStartedAtRef stamping", () => {
  it("beginTurn stamps turnStartedAtRef with the given startedAt, for any turn kind", () => {
    const deps = makeDeps();
    const lifecycle = createTurnLifecycle(deps);

    lifecycle.beginTurn("turn", { startedAt: 12345 });
    expect(deps.turnStartedAtRef.current).toBe(12345);

    // Regression: a promoted /compact runs through beginTurn("compact", ...),
    // not just "turn" — the cancellation grace timer's comparison against this
    // ref only works if EVERY kind stamps it, not just plain turns.
    lifecycle.beginTurn("compact", { startedAt: 67890 });
    expect(deps.turnStartedAtRef.current).toBe(67890);
  });

  it("endTurn does not clear turnStartedAtRef", () => {
    const deps = makeDeps();
    const lifecycle = createTurnLifecycle(deps);

    lifecycle.beginTurn("turn", { startedAt: 111 });
    lifecycle.endTurn("turn");

    expect(deps.turnStartedAtRef.current).toBe(111);
  });
});
