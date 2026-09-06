import {
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "@/ui/input/prompt-text.ts";
import {
  characterClassAt,
  displayLineDown,
  displayLineUp,
  findInLine,
  lineEnd,
  lineFirstNonBlank,
  lineStart,
  logicalLineDown,
  logicalLineUp,
  wordEndForward,
  wordStartBackward,
  wordStartForward,
} from "@/ui/input/vim/boundaries.ts";
import { MAX_MOTION_COUNT } from "@/ui/input/vim/constants.ts";
import type { VimMotion, VimOperator, VimRange } from "@/ui/input/vim/types.ts";

export interface MotionRequest {
  text: string;
  caret: number;
  /** Prompt width, needed only by the display-row motions. */
  columns: number;
  motion: VimMotion;
  /** The typed count, or null when none was. */
  count: number | null;
}

/**
 * Where a motion lands, given a count. Null when the motion cannot move —
 * `charLeft` at the start of a line, a search with no match — which the caller
 * reads as "nothing happened" rather than "stay put", so a failed motion can
 * decline the key instead of consuming it silently.
 *
 * A caret in NORMAL rests ON a grapheme rather than between two, so every
 * destination is pulled back off a line's trailing edge. The one exception is a
 * blank line, which has no grapheme to rest on.
 */
export function resolveMotion(request: MotionRequest): number | null {
  const { text, motion } = request;
  const caret = clampToText(text, request.caret);
  const landed = destination({
    text,
    caret,
    columns: request.columns,
    motion,
    count: normalizeCount(request.count),
    // The buffer motions read a count as a line number, so they need to know a
    // count was typed at all: `1G` names the first line where a bare `G` names
    // the last, and a normalized count of 1 cannot tell those apart.
    counted: request.count !== null,
  });
  if (landed === null) return null;
  const clamped = restOnGrapheme(text, landed);
  return clamped === caret ? null : clamped;
}

/**
 * Which motions cover whole lines when an operator uses them, and which include
 * the grapheme they land on. Both are properties of the motion, not of the
 * operator, which is why they live beside the resolver rather than at each caller.
 */
function isLinewise(motion: VimMotion): boolean {
  switch (motion.kind) {
    case "lineDown":
    case "lineUp":
    case "displayLineDown":
    case "displayLineUp":
    case "firstLine":
    case "lastLine":
      return true;
    default:
      return false;
  }
}

function isInclusive(motion: VimMotion): boolean {
  // `e` and `$` land on the last grapheme they mean to cover, and both character
  // searches cover the position they stop at — `dt,` takes the grapheme before
  // the comma with it.
  return motion.kind === "wordEnd" || motion.kind === "lineEnd" || motion.kind === "find";
}

/**
 * `cw` covers what `ce` covers. The word-forward motion normally reaches the next
 * word's start, which for a change would swallow the blanks between the words and
 * leave the replacement joined to the following one. On a blank the two agree, so
 * only a caret sitting inside a run is redirected.
 */
export function motionForOperator(
  operator: VimOperator,
  motion: VimMotion,
  text: string,
  caret: number,
): VimMotion {
  if (operator !== "change" || motion.kind !== "wordForward") return motion;
  if (characterClassAt(text, caret) === "blank") return motion;
  return { kind: "wordEnd", word: motion.word };
}

/**
 * The span an operator covers when it is given this motion, or null when the
 * motion cannot move and so covers nothing.
 *
 * Direction decides the shape. Forward, the span runs from the caret to the
 * destination, taking the destination's own grapheme only for an inclusive
 * motion. Backward, it runs from the destination to the caret: the destination
 * is always covered and the caret's own grapheme never is. A linewise motion
 * widens whichever span results to the whole lines it touches.
 */
export function motionRange(request: MotionRequest): VimRange | null {
  const { text, motion } = request;
  const caret = clampToText(text, request.caret);
  const landed = resolveMotion(request);
  if (landed === null) return null;
  if (isLinewise(motion)) return lineSpan(text, Math.min(caret, landed), Math.max(caret, landed));
  if (landed > caret) {
    const end = isInclusive(motion) ? nextGraphemeBoundary(text, landed) : landed;
    return { start: caret, end: Math.min(end, text.length), linewise: false };
  }
  return { start: landed, end: caret, linewise: false };
}

/**
 * The whole lines between two offsets, including the newline that ends the last
 * one when there is one. The span stays exactly the lines it names — an operator
 * needing to reach past them, as deletion does at the end of the buffer, asks for
 * that itself rather than being handed a span starting on the line before.
 */
export function lineSpan(text: string, from: number, to: number): VimRange {
  const start = logicalLineStartOffset(text, from);
  const end = logicalLineEndOffset(text, to);
  return { start, end: end < text.length ? end + 1 : end, linewise: true };
}

/**
 * The last offset a NORMAL caret may occupy on the line holding `offset`: the
 * start of the line's final grapheme, or the line start when the line is empty.
 */
export function restOnGrapheme(text: string, offset: number): number {
  const bounded = clampToText(text, offset);
  const start = logicalLineStartOffset(text, bounded);
  const end = logicalLineEndOffset(text, bounded);
  if (bounded < end || end === start) return bounded;
  return prevGraphemeBoundary(text, end);
}

function clampToText(text: string, offset: number): number {
  return Math.max(0, Math.min(offset, text.length));
}

function normalizeCount(count: number | null): number {
  if (count === null) return 1;
  return Math.max(1, Math.min(count, MAX_MOTION_COUNT));
}

interface ResolvedRequest {
  text: string;
  caret: number;
  columns: number;
  motion: VimMotion;
  count: number;
  counted: boolean;
}

function destination(request: ResolvedRequest): number | null {
  const { text, caret, columns, motion, count, counted } = request;
  switch (motion.kind) {
    case "charLeft":
      return repeatBounded(caret, count, (from) => {
        const start = logicalLineStartOffset(text, from);
        return from <= start ? null : prevGraphemeBoundary(text, from);
      });
    case "charRight":
      return repeatBounded(caret, count, (from) => {
        const end = logicalLineEndOffset(text, from);
        const next = nextGraphemeBoundary(text, from);
        return next > end ? null : next;
      });
    case "lineDown":
      return repeatBounded(caret, count, (from) => logicalLineDown(text, from));
    case "lineUp":
      return repeatBounded(caret, count, (from) => logicalLineUp(text, from));
    case "displayLineDown":
      return repeatBounded(caret, count, (from) => displayLineDown(text, from, columns));
    case "displayLineUp":
      return repeatBounded(caret, count, (from) => displayLineUp(text, from, columns));
    case "wordForward":
      return repeat(caret, count, (from) => wordStartForward(text, from, motion.word));
    case "wordBackward":
      return repeat(caret, count, (from) => wordStartBackward(text, from, motion.word));
    case "wordEnd":
      return repeat(caret, count, (from) => wordEndForward(text, from, motion.word));
    case "lineStart":
      return lineStart(text, caret);
    case "lineFirstNonBlank":
      return lineFirstNonBlank(text, caret);
    case "lineEnd":
      // A count takes `$` that many lines down first, then to that line's end.
      return lineEnd(
        text,
        repeat(caret, count - 1, (from) => logicalLineDown(text, from) ?? from),
      );
    case "firstLine":
      return lineFirstNonBlank(text, lineStartOfIndex(text, counted ? count - 1 : 0));
    case "lastLine":
      return lineFirstNonBlank(
        text,
        counted ? lineStartOfIndex(text, count - 1) : logicalLineStartOffset(text, text.length),
      );
    case "find":
      // The count names which occurrence, so the search takes it rather than the
      // repeat loop: stopping short of the second match is not stopping short twice.
      return findInLine(text, caret, motion.target, motion.direction, motion.stop, count);
  }
}

/** Applies `step` `count` times, keeping the last offset it produced. */
function repeat(from: number, count: number, step: (offset: number) => number): number {
  let cursor = from;
  for (let i = 0; i < count; i += 1) cursor = step(cursor);
  return cursor;
}

/**
 * Applies `step` up to `count` times, stopping where it runs out. A partial run
 * still counts as movement — `5j` on a two-line buffer lands on the last line
 * rather than declining — but a first step that cannot move is a failed motion.
 */
function repeatBounded(
  from: number,
  count: number,
  step: (offset: number) => number | null,
): number | null {
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const next = step(cursor);
    if (next === null) break;
    cursor = next;
  }
  return cursor === from ? null : cursor;
}

/** The start of logical line `index`, clamped to the last line. */
function lineStartOfIndex(text: string, index: number): number {
  let cursor = 0;
  for (let i = 0; i < index; i += 1) {
    const end = logicalLineEndOffset(text, cursor);
    if (end >= text.length) return cursor;
    cursor = end + 1;
  }
  return cursor;
}
