import { stringWidth } from "@/terminal-runtime";
import {
  cursorDownPosition,
  cursorUpPosition,
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "@/ui/input/prompt-text.ts";
import type { CharacterClass, FindStop, SearchDirection, WordKind } from "@/ui/input/vim/types.ts";
import { BLANK_CHARACTER, WORD_CHARACTER } from "./constants.ts";

/**
 * Position math for modal motions: where a word begins and ends, where a line
 * begins and ends, and where a character sits. Every offset it returns falls on
 * a grapheme boundary, so a caret placed there never splits a cluster.
 *
 * Nothing here knows about modes, keys or counts — a motion is a caller
 * composing these, and a count is that caller repeating one.
 */

function clampOffset(text: string, offset: number): number {
  return Math.max(0, Math.min(offset, text.length));
}

function lastGraphemeStart(text: string): number {
  return text.length === 0 ? 0 : prevGraphemeBoundary(text, text.length);
}

/**
 * The class of the grapheme starting at `offset`. Anything outside the buffer
 * reads as blank, so a walk that runs off either end simply stops finding runs
 * instead of every caller carrying its own bounds branch.
 */
export function characterClassAt(text: string, offset: number): CharacterClass {
  if (offset < 0 || offset >= text.length) return "blank";
  const first = text.slice(offset, nextGraphemeBoundary(text, offset))[0] ?? "";
  if (BLANK_CHARACTER.test(first)) return "blank";
  return WORD_CHARACTER.test(first) ? "word" : "punctuation";
}

/** Under `big` only blanks separate, so word and punctuation collapse into one run. */
function runClassAt(text: string, offset: number, kind: WordKind): CharacterClass {
  const actual = characterClassAt(text, offset);
  if (kind === "big" && actual === "punctuation") return "word";
  return actual;
}

/**
 * The start of the next run. Leaves the run the caret sits in, then crosses the
 * blanks in front of it; a caret already on a blank only crosses the blanks.
 * Runs out at the end of the buffer.
 */
export function wordStartForward(text: string, offset: number, kind: WordKind): number {
  const from = clampOffset(text, offset);
  if (from >= text.length) return text.length;
  const departing = runClassAt(text, from, kind);
  let cursor = nextGraphemeBoundary(text, from);
  if (departing !== "blank") {
    while (cursor < text.length && runClassAt(text, cursor, kind) === departing) {
      cursor = nextGraphemeBoundary(text, cursor);
    }
  }
  while (cursor < text.length && runClassAt(text, cursor, kind) === "blank") {
    cursor = nextGraphemeBoundary(text, cursor);
  }
  return cursor;
}

/**
 * The start of the run behind the caret — the current run's own start when the
 * caret sits past it, otherwise the previous run's. Runs out at offset 0.
 */
export function wordStartBackward(text: string, offset: number, kind: WordKind): number {
  const from = clampOffset(text, offset);
  if (from <= 0) return 0;
  let cursor = prevGraphemeBoundary(text, from);
  while (cursor > 0 && runClassAt(text, cursor, kind) === "blank") {
    cursor = prevGraphemeBoundary(text, cursor);
  }
  const run = runClassAt(text, cursor, kind);
  if (run === "blank") return cursor;
  while (cursor > 0) {
    const previous = prevGraphemeBoundary(text, cursor);
    if (runClassAt(text, previous, kind) !== run) break;
    cursor = previous;
  }
  return cursor;
}

/**
 * The LAST grapheme of the run ahead — a different question from where the next
 * run starts, and the reason the two are separate walks. A caret already on a
 * run's last grapheme moves on to the following run's end.
 */
export function wordEndForward(text: string, offset: number, kind: WordKind): number {
  const from = clampOffset(text, offset);
  if (from >= text.length) return lastGraphemeStart(text);
  let cursor = nextGraphemeBoundary(text, from);
  while (cursor < text.length && runClassAt(text, cursor, kind) === "blank") {
    cursor = nextGraphemeBoundary(text, cursor);
  }
  if (cursor >= text.length) return lastGraphemeStart(text);
  const run = runClassAt(text, cursor, kind);
  while (true) {
    const next = nextGraphemeBoundary(text, cursor);
    if (next >= text.length || runClassAt(text, next, kind) !== run) return cursor;
    cursor = next;
  }
}

/** The start of the caret's logical line — the line-start motion. */
export function lineStart(text: string, offset: number): number {
  return logicalLineStartOffset(text, clampOffset(text, offset));
}

/** The end of the caret's logical line, at the newline rather than past it. */
export function lineEnd(text: string, offset: number): number {
  return logicalLineEndOffset(text, clampOffset(text, offset));
}

/** The first non-blank of the caret's logical line, or its end when the line is blank. */
export function lineFirstNonBlank(text: string, offset: number): number {
  const start = lineStart(text, offset);
  const end = logicalLineEndOffset(text, start);
  let cursor = start;
  while (cursor < end && characterClassAt(text, cursor) === "blank") {
    cursor = nextGraphemeBoundary(text, cursor);
  }
  return cursor;
}

/** Display width from the caret's logical line start up to the caret. */
function columnAt(text: string, offset: number): number {
  return stringWidth(text.slice(logicalLineStartOffset(text, offset), offset));
}

/** The offset within `[start, end]` whose display column first reaches `column`. */
function offsetAtColumn(text: string, start: number, end: number, column: number): number {
  let width = 0;
  let cursor = start;
  while (cursor < end) {
    const next = nextGraphemeBoundary(text, cursor);
    const advanced = width + stringWidth(text.slice(cursor, next));
    if (advanced > column) return cursor;
    width = advanced;
    cursor = next;
  }
  return end;
}

/**
 * The same display column one logical line down, clamped to that line's end.
 * Null when the caret is already on the last logical line.
 */
export function logicalLineDown(text: string, offset: number): number | null {
  const from = clampOffset(text, offset);
  const end = logicalLineEndOffset(text, from);
  if (end >= text.length) return null;
  const start = end + 1;
  return offsetAtColumn(text, start, logicalLineEndOffset(text, start), columnAt(text, from));
}

/**
 * The same display column one logical line up, clamped to that line's end.
 * Null when the caret is already on the first logical line.
 */
export function logicalLineUp(text: string, offset: number): number | null {
  const from = clampOffset(text, offset);
  const start = logicalLineStartOffset(text, from);
  if (start <= 0) return null;
  const previous = logicalLineStartOffset(text, start - 1);
  return offsetAtColumn(text, previous, start - 1, columnAt(text, from));
}

/**
 * One display row down. A wrapped logical line spans several rows, so this and
 * `logicalLineDown` disagree whenever the text is wider than the prompt. The
 * prompt's own wrap walk already resolves rows, so the row motions defer to it
 * rather than keeping a second idea of where a row breaks.
 */
export function displayLineDown(text: string, offset: number, columns: number): number | null {
  return cursorDownPosition(text, offset, columns);
}

/** One display row up; the counterpart of `displayLineDown`. */
export function displayLineUp(text: string, offset: number, columns: number): number | null {
  return cursorUpPosition(text, offset, columns);
}

function matchForward(text: string, from: number, end: number, target: string): number | null {
  let cursor = nextGraphemeBoundary(text, from);
  while (cursor < end) {
    const next = nextGraphemeBoundary(text, cursor);
    if (text.slice(cursor, next) === target) return cursor;
    cursor = next;
  }
  return null;
}

function matchBackward(text: string, from: number, start: number, target: string): number | null {
  let cursor = from;
  while (cursor > start) {
    const previous = prevGraphemeBoundary(text, cursor);
    if (text.slice(previous, cursor) === target) return previous;
    cursor = previous;
  }
  return null;
}

/**
 * Search the caret's logical line for the `count`-th `target`, never crossing a
 * newline. The search starts strictly past the caret so a repeat advances instead
 * of finding the character it is already on.
 *
 * The stop is applied once, to the match that was reached — counting is about
 * which occurrence, not about stopping short repeatedly. Landing one short of the
 * second occurrence is a different place from stopping short twice.
 *
 * Null when there is no `count`-th match, and also when the result lands the
 * caret back where it started: a search that cannot move has found nothing the
 * caller can use.
 */
export function findInLine(
  text: string,
  offset: number,
  target: string,
  direction: SearchDirection,
  stop: FindStop,
  count = 1,
): number | null {
  if (target.length === 0 || count < 1) return null;
  const from = clampOffset(text, offset);
  const lineEnd = logicalLineEndOffset(text, from);
  const lineStartOffset = logicalLineStartOffset(text, from);
  let match: number | null = null;
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    match =
      direction === "forward"
        ? matchForward(text, cursor, lineEnd, target)
        : matchBackward(text, cursor, lineStartOffset, target);
    if (match === null) return null;
    cursor = match;
  }
  if (match === null) return null;
  if (stop === "on") return match === from ? null : match;
  const stopped =
    direction === "forward" ? prevGraphemeBoundary(text, match) : nextGraphemeBoundary(text, match);
  return stopped === from ? null : stopped;
}
