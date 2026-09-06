import {
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "@/ui/input/prompt-text.ts";
import { characterClassAt } from "@/ui/input/vim/boundaries.ts";
import type { VimRange, WordKind } from "@/ui/input/vim/types.ts";

/**
 * Text objects: the span a `iw`-style command covers. Each answers with the same
 * shape a motion-derived range has, so an operator treats the two identically.
 *
 * Null means the caret is nowhere the object exists — outside any quoted run, or
 * with no enclosing bracket — which the caller reads as "the command found
 * nothing" rather than acting on an empty span.
 */

/** The three quote characters, which pair by position along the line. */
export const QUOTES = ["'", '"', "`"] as const;

/** The bracket pairs, which pair by nesting depth. */
export const BRACKETS: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
};

const OPENERS = new Set(["(", "[", "{", "<"]);

/**
 * The run under the caret. `inner` is the run itself; `around` adds the blanks
 * after it, falling back to the blanks before it when the run ends the line —
 * which is what makes `daw` on the last word not leave a trailing space.
 */
export function wordObject(
  text: string,
  caret: number,
  kind: WordKind,
  around: boolean,
): VimRange | null {
  if (text.length === 0) return null;
  const runClass = (offset: number): string => {
    const actual = characterClassAt(text, offset);
    return kind === "big" && actual === "punctuation" ? "word" : actual;
  };
  const at = runClass(caret);
  let start = caret;
  while (start > 0 && runClass(prevGraphemeBoundary(text, start)) === at) {
    start = prevGraphemeBoundary(text, start);
  }
  let end = caret;
  while (end < text.length && runClass(end) === at) end = nextGraphemeBoundary(text, end);
  if (end === start) return null;
  if (!around) return { start, end, linewise: false };
  let widened = end;
  while (
    widened < text.length &&
    characterClassAt(text, widened) === "blank" &&
    text[widened] !== "\n"
  ) {
    widened = nextGraphemeBoundary(text, widened);
  }
  if (widened > end) return { start, end: widened, linewise: false };
  let back = start;
  while (back > 0) {
    const previous = prevGraphemeBoundary(text, back);
    if (characterClassAt(text, previous) !== "blank" || text[previous] === "\n") break;
    back = previous;
  }
  return { start: back, end, linewise: false };
}

/**
 * The quoted run the caret sits in or ahead of. Quotes carry no nesting, so they
 * pair by position: the first and second on the line, then the third and fourth.
 * A caret between two pairs belongs to the one that opens after it, which is what
 * lets `ci"` work with the caret at the start of the line.
 */
export function quoteObject(
  text: string,
  caret: number,
  quote: string,
  around: boolean,
): VimRange | null {
  const lineStart = logicalLineStartOffset(text, caret);
  const lineEnd = logicalLineEndOffset(text, caret);
  const positions: number[] = [];
  for (let i = lineStart; i < lineEnd; i = nextGraphemeBoundary(text, i)) {
    if (text.slice(i, nextGraphemeBoundary(text, i)) === quote) positions.push(i);
  }
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i] as number;
    const close = positions[i + 1] as number;
    if (caret > close) continue;
    return around
      ? { start: open, end: nextGraphemeBoundary(text, close), linewise: false }
      : { start: nextGraphemeBoundary(text, open), end: close, linewise: false };
  }
  return null;
}

/**
 * The bracketed run enclosing the caret, found by depth. A caret sitting on the
 * opener or the closer counts as inside, which is what vim does and what a reader
 * pressing `di(` on the bracket itself means.
 */
export function bracketObject(
  text: string,
  caret: number,
  bracket: string,
  around: boolean,
): VimRange | null {
  const open = OPENERS.has(bracket) ? bracket : (BRACKETS[bracket] as string);
  const close = BRACKETS[open] as string;
  const at = text.slice(caret, nextGraphemeBoundary(text, caret));
  const openAt = at === open ? caret : scanBack(text, caret, open, close);
  if (openAt === null) return null;
  const closeAt = scanForward(text, openAt, open, close);
  if (closeAt === null) return null;
  if (around) return { start: openAt, end: nextGraphemeBoundary(text, closeAt), linewise: false };
  const inner = { start: nextGraphemeBoundary(text, openAt), end: closeAt, linewise: false };
  return inner.end < inner.start ? null : inner;
}

/** The unmatched opener before `caret`, or null when the caret is not enclosed. */
function scanBack(text: string, caret: number, open: string, close: string): number | null {
  let depth = 0;
  let cursor = caret;
  while (cursor > 0) {
    cursor = prevGraphemeBoundary(text, cursor);
    const glyph = text.slice(cursor, nextGraphemeBoundary(text, cursor));
    if (glyph === close) depth += 1;
    else if (glyph === open) {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return null;
}

/** The closer matching the opener at `openAt`. */
function scanForward(text: string, openAt: number, open: string, close: string): number | null {
  let depth = 0;
  let cursor = nextGraphemeBoundary(text, openAt);
  while (cursor < text.length) {
    const next = nextGraphemeBoundary(text, cursor);
    const glyph = text.slice(cursor, next);
    if (glyph === open) depth += 1;
    else if (glyph === close) {
      if (depth === 0) return cursor;
      depth -= 1;
    }
    cursor = next;
  }
  return null;
}

/**
 * The span a text-object key names, or null when that key names no object. One
 * lookup for every object, so the key table stays a table.
 */
export function textObject(
  text: string,
  caret: number,
  key: string,
  around: boolean,
): VimRange | null {
  if (key === "w") return wordObject(text, caret, "small", around);
  if (key === "W") return wordObject(text, caret, "big", around);
  if ((QUOTES as readonly string[]).includes(key)) {
    return quoteObject(text, caret, key, around);
  }
  if (key in BRACKETS) return bracketObject(text, caret, key, around);
  // `b` and `B` are the spoken forms of the round and curly pairs.
  if (key === "b") return bracketObject(text, caret, "(", around);
  if (key === "B") return bracketObject(text, caret, "{", around);
  return null;
}

/** True when a key names a text object at all, so an unknown one can be declined. */
export function namesTextObject(key: string): boolean {
  return (
    key === "w" ||
    key === "W" ||
    key === "b" ||
    key === "B" ||
    (QUOTES as readonly string[]).includes(key) ||
    key in BRACKETS
  );
}
