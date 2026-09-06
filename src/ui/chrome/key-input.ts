import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";

/**
 * Shared key-event interpretation for the string-view surfaces. One home keeps
 * every panel and the prompt agreeing on what counts as typed text.
 */

/**
 * Whether a single character is text rather than a control signal. The one place
 * the boundary is drawn — C0 controls, DEL and escape are never typed text — so a
 * surface cannot end up accepting an escape byte into a field because it wrote its
 * own version of this check.
 */
function isPrintableCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && code !== 0x1b;
}

/** Whether a decoded key sequence inserts as text (single printable code point). */
export function isInsertable(sequence: string): boolean {
  if (sequence.length === 0) return false;
  return isPrintableCharacter(sequence);
}

/**
 * The printable characters of an input, in order. Used where input arrives as a
 * run rather than a keystroke — a paste, or a burst of fast typing — and only the
 * text part of it belongs in a field.
 */
export function printableText(input: string): string {
  let out = "";
  for (const character of input) {
    if (isPrintableCharacter(character)) out += character;
  }
  return out;
}

/**
 * The comparable input a key contributes: its name under modifiers, its
 * insertable text otherwise. Control and escape-led sequences contribute
 * nothing, so navigation keys never read as typed characters.
 */
export function keyInput(key: KeyEventData): string {
  if (key.ctrl || key.meta) return key.name ?? "";
  if (key.name === "space") return " ";
  const sequence = key.sequence ?? "";
  return isInsertable(sequence) ? sequence : "";
}

/**
 * The text a key event types, or nothing when it carries a gesture instead. A held
 * Ctrl or Meta makes the key a command, and `keyInput` reports a modified key by
 * NAME — which would otherwise read as someone typing that name.
 */
export function typedText(key: KeyEventData): string {
  if (key.ctrl || key.meta) return "";
  return keyInput(key);
}
