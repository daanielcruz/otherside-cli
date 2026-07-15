import { describe, expect, it } from "bun:test";
import { TurnGuard } from "../turn/guard.ts";

describe("TurnGuard lifecycle", () => {
  it("begins idle and inactive", () => {
    const guard = new TurnGuard();
    expect(guard.active).toBe(false);
    expect(guard.generation).toBe(0);
  });

  it("begin() activates and returns a monotonically increasing generation", () => {
    const guard = new TurnGuard();
    const g1 = guard.begin();
    expect(g1).toBe(1);
    expect(guard.active).toBe(true);
    expect(guard.settle(g1!)).toBe(true);
    expect(guard.begin()).toBe(2);
  });

  it("settle() with the live generation ends the turn and returns true", () => {
    const guard = new TurnGuard();
    const gen = guard.begin()!;
    expect(guard.settle(gen)).toBe(true);
    expect(guard.active).toBe(false);
  });

  it("settle() with a stale generation is a no-op returning false", () => {
    const guard = new TurnGuard();
    const stale = guard.begin()!;
    guard.settle(stale);
    const live = guard.begin()!;
    expect(guard.settle(stale)).toBe(false);
    expect(guard.active).toBe(true); // the live turn is untouched
    expect(guard.settle(live)).toBe(true);
  });

  it("begin() while active returns null (concurrent-dispatch guard)", () => {
    const guard = new TurnGuard();
    guard.begin();
    expect(guard.begin()).toBe(null);
  });
});

describe("TurnGuard cancel race — the cancelled turn's finally is a no-op", () => {
  it("abort() bumps the generation so the in-flight turn's settle() returns false", () => {
    const guard = new TurnGuard();
    const generation = guard.begin()!; // turn dispatched

    guard.abort(); // user cancels mid-stream
    expect(guard.active).toBe(false);

    // the cancelled turn's deferred finally runs and tries to settle/resume —
    // it must see a mismatch and skip every resume decision.
    expect(guard.settle(generation)).toBe(false);
  });

  it("a fresh turn after abort gets a new generation and settles cleanly", () => {
    const guard = new TurnGuard();
    const cancelled = guard.begin()!;
    guard.abort();

    const fresh = guard.begin()!;
    expect(fresh).not.toBe(cancelled);
    expect(guard.settle(cancelled)).toBe(false); // cancelled finally still no-ops
    expect(guard.active).toBe(true);
    expect(guard.settle(fresh)).toBe(true);
  });

  it("abort() on an idle guard does nothing (no spurious generation bump)", () => {
    const guard = new TurnGuard();
    const before = guard.generation;
    guard.abort();
    expect(guard.generation).toBe(before);
    expect(guard.active).toBe(false);
  });

  it("models a cancel epoch a concurrent path can read without begin/settle", () => {
    const guard = new TurnGuard();
    guard.begin(); // a main turn is live
    const startGen = guard.generation; // a skill captures the epoch
    expect(guard.generation).toBe(startGen); // no cancel yet
    guard.abort(); // user cancels
    expect(guard.generation).not.toBe(startGen); // the skill detects the cancel
  });
});

describe("TurnGuard reservation — the dispatching state", () => {
  it("reserve() claims an idle guard (idle→dispatching) and marks it active", () => {
    const guard = new TurnGuard();
    expect(guard.active).toBe(false);
    expect(guard.reserve()).toBe(true);
    expect(guard.active).toBe(true); // dispatching counts as active
    expect(guard.generation).toBe(0); // no turn ran yet — generation untouched
  });

  it("reserve() loses when the guard is already dispatching", () => {
    const guard = new TurnGuard();
    expect(guard.reserve()).toBe(true);
    expect(guard.reserve()).toBe(false); // second claimant loses the race
    expect(guard.active).toBe(true);
  });

  it("reserve() loses when a turn is already running", () => {
    const guard = new TurnGuard();
    guard.begin();
    expect(guard.reserve()).toBe(false);
  });

  it("begin() promotes a reservation to running (dispatching→running) with a fresh generation", () => {
    const guard = new TurnGuard();
    guard.reserve();
    const gen = guard.begin();
    expect(gen).toBe(1);
    expect(guard.active).toBe(true);
    expect(guard.settle(gen!)).toBe(true); // running→idle
    expect(guard.active).toBe(false);
  });

  it("cancelReservation() releases a reservation (dispatching→idle) without bumping the generation", () => {
    const guard = new TurnGuard();
    guard.reserve();
    const before = guard.generation;
    guard.cancelReservation();
    expect(guard.active).toBe(false);
    expect(guard.generation).toBe(before); // nothing ran → no cancel epoch bump
    expect(guard.reserve()).toBe(true); // guard is idle again and reusable
  });

  it("cancelReservation() is a no-op when idle or running", () => {
    const guard = new TurnGuard();
    guard.cancelReservation(); // idle → no-op
    expect(guard.active).toBe(false);
    const gen = guard.begin()!; // running
    guard.cancelReservation(); // must NOT end a running turn
    expect(guard.active).toBe(true);
    expect(guard.settle(gen)).toBe(true);
  });

  it("abort() clears a bare reservation (dispatching→idle)", () => {
    const guard = new TurnGuard();
    guard.reserve();
    guard.abort();
    expect(guard.active).toBe(false);
  });

  it("full reserve→begin→settle cycle mirrors a forced queue promotion", () => {
    const guard = new TurnGuard();
    expect(guard.reserve()).toBe(true); // cancelled turn's finally claims the guard
    const gen = guard.begin()!; // runSubmittedTurn dispatches the promoted message
    expect(guard.active).toBe(true);
    expect(guard.settle(gen)).toBe(true); // promoted turn ends cleanly
    expect(guard.active).toBe(false);
  });
});

describe("TurnGuard.claim() — idempotent single-flight gate", () => {
  it("claims an idle guard (idle→dispatching)", () => {
    const guard = new TurnGuard();
    expect(guard.claim()).toBe(true);
    expect(guard.active).toBe(true);
    expect(guard.generation).toBe(0); // no turn ran yet
  });

  it("is a no-op when already dispatching (a caller pre-reserved)", () => {
    const guard = new TurnGuard();
    guard.reserve();
    expect(guard.claim()).toBe(true); // does not fail on its own reservation
    expect(guard.active).toBe(true);
    const gen = guard.begin()!;
    expect(guard.settle(gen)).toBe(true);
  });

  it("fails when a turn is already running", () => {
    const guard = new TurnGuard();
    guard.begin();
    expect(guard.claim()).toBe(false);
    expect(guard.active).toBe(true); // the running turn is untouched
  });

  it("claim() then begin() runs the claiming turn", () => {
    const guard = new TurnGuard();
    expect(guard.claim()).toBe(true);
    const gen = guard.begin();
    expect(gen).not.toBe(null);
    expect(guard.settle(gen!)).toBe(true);
  });
});
