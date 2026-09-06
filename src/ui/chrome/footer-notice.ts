import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";

/**
 * The footer's transient row — the prompt's notice, the twice-to-exit hint — speaks
 * for a moment and leaves. Backspace and delete put it away early, so the reader is
 * never stuck reading a line it is done with. Modified backspaces belong to the kill
 * ring, so only the bare keys dismiss.
 */
export function isFooterNoticeDismissKey(key: KeyEventData): boolean {
  if (key.ctrl || key.meta) return false;
  return key.name === "backspace" || key.name === "delete";
}
