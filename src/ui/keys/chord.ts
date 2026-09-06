import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";

/**
 * One spelling for a key combination, so a table lookup and a typed binding can
 * be compared as strings.
 *
 * A chord is one or more steps separated by spaces; a step is zero or more
 * modifiers and one key name joined by `+`. **Steps split before modifiers do** —
 * reading `+` first turns `ctrl+x ctrl+e` into a modifier list with `x ctrl`
 * inside it, which matches nothing and fails silently.
 */

/** The modifier names a normalized step uses, in the order it sorts them. */
const CANONICAL_MODIFIERS = ["alt", "cmd", "ctrl", "meta", "shift"] as const;

type CanonicalModifier = (typeof CANONICAL_MODIFIERS)[number];

/** Spellings a user may type, folded onto the canonical name. */
const MODIFIER_ALIASES: Readonly<Record<string, CanonicalModifier>> = {
  alt: "alt",
  cmd: "cmd",
  command: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  opt: "alt",
  option: "alt",
  shift: "shift",
  super: "cmd",
};

const MODIFIER_ORDER: ReadonlyMap<CanonicalModifier, number> = new Map(
  CANONICAL_MODIFIERS.map((name, index) => [name, index]),
);

function sortModifiers(modifiers: Iterable<CanonicalModifier>): CanonicalModifier[] {
  return [...new Set(modifiers)].sort(
    (a, b) => (MODIFIER_ORDER.get(a) ?? 0) - (MODIFIER_ORDER.get(b) ?? 0),
  );
}

function formatStep(modifiers: Iterable<CanonicalModifier>, keyName: string): string {
  return [...sortModifiers(modifiers), keyName].join("+");
}

/**
 * Normalize one step: lowercase it, fold modifier aliases, sort the modifiers,
 * and rejoin. Returns null when the step carries no key name — a bare modifier
 * list is not a binding.
 */
function normalizeStep(step: string): string | null {
  const trimmed = step.trim();
  if (trimmed.length === 0) return null;
  // `+` is both the separator and a bindable key, so a step ending in one names
  // the plus key and everything before it is modifiers.
  const namesPlus = trimmed.endsWith("+");
  const body = namesPlus ? trimmed.slice(0, -1) : trimmed;
  const parts = body
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!namesPlus && parts.length === 0) return null;

  const modifiers: CanonicalModifier[] = [];
  let keyName: string | null = namesPlus ? "+" : null;
  for (const [index, part] of parts.entries()) {
    const isLast = !namesPlus && index === parts.length - 1;
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    // The last part is the key even when it spells a modifier name.
    if (modifier !== undefined && !isLast) {
      modifiers.push(modifier);
      continue;
    }
    if (isLast) keyName = part;
    else return null;
  }
  return keyName === null ? null : formatStep(modifiers, canonicalKeyName(keyName, modifiers));
}

/**
 * Only a bare typed character is case-sensitive: `g` and `G` are two bindings a
 * reader can tell apart. A named key, or any key under a modifier, arrives from
 * the decoder lowercased — so keeping `ctrl+A` distinct would spell a binding
 * that no press can ever match.
 */
function canonicalKeyName(keyName: string, modifiers: readonly CanonicalModifier[]): string {
  const bareCharacter = modifiers.length === 0 && !isNamedKey(keyName);
  return bareCharacter ? keyName : keyName.toLowerCase();
}

/**
 * Normalize a whole chord. Returns null when any step is unreadable, so a
 * malformed binding is rejected rather than half-applied.
 */
export function normalizeChord(chord: string): string | null {
  const steps = chord
    .split(/\s+/)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  if (steps.length === 0) return null;

  const normalized: string[] = [];
  for (const step of steps) {
    const normalizedStep = normalizeStep(step);
    if (normalizedStep === null) return null;
    normalized.push(normalizedStep);
  }
  return normalized.join(" ");
}

/**
 * The normalized single step a decoded key press spells, or null when the press
 * carries no name to bind against (a bare paste, an unrecognized sequence).
 */
export function chordStepForKey(key: KeyEventData): string | null {
  const modifiers: CanonicalModifier[] = [];
  if (key.ctrl) modifiers.push("ctrl");
  if (key.meta) modifiers.push("meta");
  if (key.option) modifiers.push("alt");
  if (key.super) modifiers.push("cmd");

  // Shift only distinguishes a NAMED key. On a letter it was already spent
  // producing the capital, and binding `shift+a` beside `A` would give one
  // press two spellings.
  const named = key.name !== undefined && isNamedKey(key.name);
  if (key.shift && named) modifiers.push("shift");

  // Many terminals send a Meta chord as ESC followed by the letter and set no
  // modifier and no name, so the press arrives spelled as nothing the table could
  // hold. It IS `meta+<letter>` — recovering that here is what lets the table
  // express what the terminal actually sends.
  const escapePrefixed = metaLetterFromSequence(key);
  if (escapePrefixed !== null) return formatStep([...modifiers, "meta"], escapePrefixed);

  // A named key, or any key under a modifier, binds by its decoder name:
  // `space` rather than the blank it types, which a whitespace split would eat.
  // The one exception is a digit: the decoder names every one of them `number`,
  // which says only THAT a digit was pressed and never which — so a digit binds by
  // the character it typed, the way an unmodified letter does.
  if ((named && !namesADigit(key)) || modifiers.length > 0) {
    return key.name === undefined ? null : formatStep(modifiers, key.name.toLowerCase());
  }

  // An unmodified printable character binds VERBATIM, so `g` and `G` stay two.
  // A space is the exception in both directions: chords split ON spaces, so a step
  // that IS one could never be parsed back, and the table already spells it by the
  // decoder's name. A press carrying only the blank means the same key.
  const typed = printableCharacter(key);
  if (typed === " ") return formatStep(modifiers, "space");
  if (typed !== null) return typed;

  return key.name === undefined ? null : formatStep(modifiers, key.name);
}

/** Whether a key name is a named key rather than a single typed character. */
function isNamedKey(keyName: string): boolean {
  return [...keyName].length > 1;
}

/**
 * The letter of an ESC-prefixed Meta chord, or null when the press is not one.
 *
 * A decoder may report the name as missing OR as empty, and may or may not set the
 * meta flag — the sequence is the only part that always says what was pressed.
 */
function metaLetterFromSequence(key: KeyEventData): string | null {
  if (key.name !== undefined && key.name.length > 0) return null;
  return /^\x1b([a-z])$/i.exec(key.sequence ?? "")?.[1]?.toLowerCase() ?? null;
}

/** The decoder's collective name for the digit row, which hides which digit it was. */
const DIGIT_KEY_NAME = "number";

function namesADigit(key: KeyEventData): boolean {
  return key.name === DIGIT_KEY_NAME && printableCharacter(key) !== null;
}

function printableCharacter(key: KeyEventData): string | null {
  const sequence = key.sequence ?? "";
  if (sequence.length === 0 || [...sequence].length !== 1) return null;
  const code = sequence.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f || code === 0x1b) return null;
  return sequence;
}

/** The steps of a normalized chord, for a resolver walking one press at a time. */
export function chordSteps(normalizedChord: string): string[] {
  return normalizedChord.split(" ").filter((step) => step.length > 0);
}
