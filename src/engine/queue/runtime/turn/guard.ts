// Single synchronous source of truth for "is a turn live, and which one".
//
// The TUI dispatches a turn, may cancel it mid-stream, then drains queued or
// auto-resume work once it settles. Without a generation token the cancelled
// turn's own `finally` cannot tell whether IT is still the live turn — so a
// resume decision taken there races the cancel and re-runs the turn the user
// just stopped ("cancels and comes back"). The generation counter closes that:
// `abort()` (on cancel/clear) bumps the generation, so the cancelled turn's
// deferred `settle(generation)` sees a mismatch and returns false → its resume
// is a no-op. The counter doubles as a "cancel epoch" any concurrent path can
// read: capture `generation` at the start, and `generation !== guard.generation`
// later means a cancel landed in between. Synchronous (not React state) so it is
// never subject to render batching lag.
//
// Three states of the turn guard:
//   idle        — no turn; the guard can be reserved or begun.
//   dispatching — reserved for an imminent dispatch, not yet running. Lets a
//                 caller atomically claim the guard across an async gap (e.g. a
//                 cancelled turn's finally that wants to force-promote OTHER
//                 queued messages) so a concurrent real turn loses the race.
//   running     — a turn is live and owns the current generation.
// `reserve()` (idle→dispatching) is the atomic claim; `begin()` accepts either
// idle or dispatching and transitions to running; `cancelReservation()` releases
// a reservation that will not be followed by a begin() (dispatching→idle).

type TurnGuardState = "idle" | "dispatching" | "running";

export class TurnGuard {
  private state: TurnGuardState = "idle";
  private gen = 0;

  // Atomically reserve the guard for an imminent dispatch: idle→dispatching.
  // Returns false when the guard is not idle (already dispatching or running), so
  // the caller lost the race and must NOT proceed. The generation is untouched —
  // no turn has started yet; begin() assigns it.
  reserve(): boolean {
    if (this.state !== "idle") return false;
    this.state = "dispatching";
    return true;
  }

  // Release a reservation that will not be followed by begin(): dispatching→idle.
  // No-op when not dispatching. The generation is NOT bumped — nothing ran, so
  // there is no in-flight settle() to invalidate.
  cancelReservation(): void {
    if (this.state !== "dispatching") return;
    this.state = "idle";
  }

  // Idempotent claim for a dispatcher that has not already reserved: idle or
  // dispatching → dispatching (no-op if already dispatching, e.g. a caller
  // pre-reserved on this dispatch's behalf), false only when a turn is already
  // running. Callers use this at the very top of a dispatch path, before any
  // await or session/transcript mutation, so a second concurrent dispatch is
  // rejected before it does any observable work rather than after racing
  // begin() deep inside the call.
  claim(): boolean {
    if (this.state === "running") return false;
    this.state = "dispatching";
    return true;
  }

  // Begin a turn: idle|dispatching → running, bumping the generation and
  // returning its token. Returns null if a turn is already running
  // (concurrent-dispatch guard — callers gate on this defensively). Accepting the
  // `dispatching` state lets a prior reserve() flow straight into a real turn.
  begin(): number | null {
    if (this.state === "running") return null;
    this.state = "running";
    this.gen += 1;
    return this.gen;
  }

  // End a turn, only if `generation` is still the live one. Returns true when the
  // caller owns the live turn and should run its cleanup/resume; false when the
  // turn was aborted or superseded (stale finally → no-op).
  settle(generation: number): boolean {
    if (this.state !== "running") return false;
    if (this.gen !== generation) return false;
    this.state = "idle";
    return true;
  }

  // Force the guard to idle and bump the generation so a running turn's later
  // `settle(generation)` returns false. Used on user cancel and transcript clear.
  // No-op when already idle (no spurious generation bump).
  abort(): void {
    if (this.state === "idle") return;
    this.state = "idle";
    this.gen += 1;
  }

  // Active for BOTH a pending dispatch (dispatching) and a live turn (running), so
  // cancel/clear logic treats a reserved-but-not-yet-started turn as live.
  get active(): boolean {
    return this.state !== "idle";
  }

  get generation(): number {
    return this.gen;
  }
}
