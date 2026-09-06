/**
 * What counts as belonging to a word. Letters, digits and the underscore are
 * one class; everything else printable is punctuation, which forms runs of its
 * own that small-word motions stop at.
 */
export const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** What separates runs without belonging to either of them. A newline is blank. */
export const BLANK_CHARACTER = /\s/u;

/**
 * The largest count a motion honours. Well past any prompt's length, so it only
 * ever bounds a typo — the point is that a held digit key cannot ask for work
 * proportional to what was typed.
 */
export const MAX_MOTION_COUNT = 10_000;
