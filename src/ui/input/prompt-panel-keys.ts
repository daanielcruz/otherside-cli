import { type OverlayName, overlayStack } from "@/store/overlay-stack/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";

export interface PromptPanelKeyState {
  /** The key's name once legacy meta sequences are resolved. */
  readonly keyName: string | undefined;
}

/**
 * Panels the prompt opens straight from a keystroke: Meta+P reaches the model
 * picker from anywhere in the buffer. Every printable character belongs to the
 * buffer, so help is reachable by its slash command alone.
 */
export function promptPanelFor(key: KeyEventData, state: PromptPanelKeyState): OverlayName | null {
  return key.meta && !key.ctrl && state.keyName === "p" ? "model" : null;
}

/** The same door the slash command goes through. */
export function openPromptPanel(name: OverlayName): void {
  overlayStack.open(name);
}
