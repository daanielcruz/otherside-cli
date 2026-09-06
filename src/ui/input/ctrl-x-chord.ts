import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";

/**
 * The Ctrl+X prefix, shared by every surface that finishes it: Ctrl+X Ctrl+K stops
 * the running agents, Ctrl+X Ctrl+E opens the prompt in an editor. One armed slot
 * and one window, so the surface that arms the prefix and the surface that claims
 * it never disagree about whether it is pending.
 */
/** A chord left unfinished for this long is abandoned, and the prefix stops waiting. */
export const CTRL_X_CHORD_WINDOW_MS = 1_000;

let armedAt: number | null = null;

export function isCtrlXPrefix(key: Pick<KeyEventData, "ctrl" | "name">): boolean {
  return key.ctrl && key.name === "x";
}

/** The keys that finish the prefix; anything else lets it go. */
export function continuesCtrlXChord(key: Pick<KeyEventData, "ctrl" | "name">): boolean {
  return key.ctrl && (key.name === "k" || key.name === "e");
}

export function armCtrlXChord(now: number = Date.now()): void {
  armedAt = now;
}

export function ctrlXChordArmed(now: number = Date.now()): boolean {
  if (armedAt === null) return false;
  if (now - armedAt > CTRL_X_CHORD_WINDOW_MS) {
    armedAt = null;
    return false;
  }
  return true;
}

/** Claims a pending prefix: the continuation key consumes it exactly once. */
export function takeCtrlXChord(now: number = Date.now()): boolean {
  const armed = ctrlXChordArmed(now);
  armedAt = null;
  return armed;
}

export function releaseCtrlXChord(): void {
  armedAt = null;
}
