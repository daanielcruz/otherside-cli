// Session-wide interaction clock: when the user last touched the keyboard.
// The baseline is process start, so "idle for N minutes" holds in a session
// that never saw a keystroke. Fed from the prompt input path; read by
// consumers that must stay out of the user's way while the user is active
// (forced GC sweeps, memory-pressure reaps).
let lastInteractionAt = Date.now();

export function noteInteraction(nowMs: number = Date.now()): void {
  lastInteractionAt = nowMs;
}

export function lastInteractionTime(): number {
  return lastInteractionAt;
}
