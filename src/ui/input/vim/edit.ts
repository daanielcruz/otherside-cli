import {
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
} from "@/ui/input/prompt-text.ts";
import { lineFirstNonBlank } from "@/ui/input/vim/boundaries.ts";
import { restOnGrapheme } from "@/ui/input/vim/motion.ts";
import type { VimOperator, VimRange, VimRegister } from "@/ui/input/vim/types.ts";

/**
 * Operators as pure edits: each answers with the whole draft it produces and
 * where the caret belongs in it, plus what went to the register when something
 * was taken. Nothing here reads or writes state — the session decides what to
 * keep and what mode to end in.
 */
export interface VimEdit {
  text: string;
  caret: number;
  /** Present when the edit took text with it, ready for the register. */
  taken?: VimRegister;
}

/** Two spaces, because the prompt is one buffer and has no tab stops to honour. */
export const INDENT = "  ";

/** What each operator does to a span. The one place an operator name resolves. */
export function runOperator(operator: VimOperator, text: string, range: VimRange): VimEdit {
  switch (operator) {
    case "delete":
      return deleteRange(text, range);
    case "change":
      return changeRange(text, range);
    case "yank":
      return yankRange(text, range);
    case "shiftRight":
      return shiftLines(text, range, "right");
    case "shiftLeft":
      return shiftLines(text, range, "left");
  }
}

export function yankRange(text: string, range: VimRange): VimEdit {
  return {
    text,
    // A yank leaves the draft alone and pulls the caret to the span's start,
    // which for a linewise yank is the first line it covered.
    caret: restOnGrapheme(
      text,
      range.linewise ? lineFirstNonBlank(text, range.start) : range.start,
    ),
    taken: takenFrom(text, range),
  };
}

export function deleteRange(text: string, range: VimRange): VimEdit {
  const taken = takenFrom(text, range);
  // A linewise span at the end of the buffer has no trailing newline of its own,
  // so deletion takes the one in front of it instead — otherwise removing the last
  // line leaves a blank one where it used to be.
  const start =
    range.linewise && range.end >= text.length && range.start > 0 && text[range.start - 1] === "\n"
      ? range.start - 1
      : range.start;
  const next = text.slice(0, start) + text.slice(range.end);
  return {
    text: next,
    caret: restOnGrapheme(
      next,
      range.linewise ? lineFirstNonBlank(next, Math.min(start, next.length)) : start,
    ),
    taken,
  };
}

/**
 * What `c` leaves behind. A linewise change empties the lines instead of removing
 * them, because insert has to open on a line that exists — and the caret is not
 * pulled back onto a grapheme, since insert sits between two.
 */
export function changeRange(text: string, range: VimRange): VimEdit {
  const taken = takenFrom(text, range);
  if (!range.linewise) {
    return { text: text.slice(0, range.start) + text.slice(range.end), caret: range.start, taken };
  }
  const end = text[range.end - 1] === "\n" ? range.end - 1 : range.end;
  return {
    text: text.slice(0, range.start) + text.slice(end),
    caret: range.start,
    taken,
  };
}

/**
 * Puts the register after the caret — after the line for a linewise register,
 * after the caret's own grapheme otherwise. An empty register is a no-op the
 * caller can spot by the draft coming back unchanged.
 */
export function pasteAfter(text: string, caret: number, register: VimRegister): VimEdit {
  if (register.text.length === 0) return { text, caret };
  if (!register.linewise) {
    const at = text.length === 0 ? 0 : nextGraphemeBoundary(text, caret);
    const next = text.slice(0, at) + register.text + text.slice(at);
    return { text: next, caret: restOnGrapheme(next, at + register.text.length - 1) };
  }
  const lineEnd = logicalLineEndOffset(text, caret);
  const body = linewiseBody(register.text);
  const next = `${text.slice(0, lineEnd)}\n${body}${text.slice(lineEnd)}`;
  return { text: next, caret: lineFirstNonBlank(next, lineEnd + 1) };
}

/** Puts the register before the caret, or above the line for a linewise register. */
export function pasteBefore(text: string, caret: number, register: VimRegister): VimEdit {
  if (register.text.length === 0) return { text, caret };
  if (!register.linewise) {
    const next = text.slice(0, caret) + register.text + text.slice(caret);
    return { text: next, caret: restOnGrapheme(next, caret + register.text.length - 1) };
  }
  const start = logicalLineStartOffset(text, caret);
  const body = linewiseBody(register.text);
  const next = `${text.slice(0, start) + body}\n${text.slice(start)}`;
  return { text: next, caret: lineFirstNonBlank(next, start) };
}

/** `x`: takes the grapheme under the caret, and nothing when the line is empty. */
export function deleteGrapheme(text: string, caret: number, count: number): VimEdit {
  const lineEnd = logicalLineEndOffset(text, caret);
  let end = caret;
  for (let i = 0; i < count && end < lineEnd; i += 1) end = nextGraphemeBoundary(text, end);
  if (end === caret) return { text, caret };
  return deleteRange(text, { start: caret, end, linewise: false });
}

/** `r`: overwrites the grapheme under the caret, leaving the caret on it. */
export function replaceGrapheme(text: string, caret: number, replacement: string): VimEdit {
  const lineEnd = logicalLineEndOffset(text, caret);
  if (caret >= lineEnd) return { text, caret };
  const end = nextGraphemeBoundary(text, caret);
  return { text: text.slice(0, caret) + replacement + text.slice(end), caret };
}

/** `r` over a whole span: every grapheme becomes the replacement, newlines stay. */
export function replaceSpan(text: string, range: VimRange, replacement: string): VimEdit {
  const kept = text.slice(range.start, range.end).replace(/[^\n]/gu, replacement);
  return { text: text.slice(0, range.start) + kept + text.slice(range.end), caret: range.start };
}

/** `~` over a whole span, rather than the grapheme under the caret alone. */
export function toggleCaseSpan(text: string, range: VimRange): VimEdit {
  return toggleCase(text, range.start, range.end - range.start);
}

/** `J` over a whole span: every line it touches is pulled onto the first. */
export function joinSpan(text: string, range: VimRange): VimEdit {
  const body = text.slice(range.start, Math.max(range.start, range.end - 1));
  return joinLines(text, range.start, body.split("\n").length + 1);
}

/**
 * `p` over a selection: what was selected goes to the register and the register
 * takes its place. The register lands where the selection started, not where the
 * caret came to rest — deletion pulls the caret back onto a grapheme, which would
 * put the text one place early.
 */
export function pasteOverSpan(text: string, range: VimRange, register: VimRegister): VimEdit {
  const removed = deleteRange(text, range);
  const put = pasteBefore(removed.text, range.start, register);
  return removed.taken === undefined ? put : { ...put, taken: removed.taken };
}

/** `~`: flips the case of the grapheme under the caret and steps past it. */
export function toggleCase(text: string, caret: number, count: number): VimEdit {
  const lineEnd = logicalLineEndOffset(text, caret);
  if (caret >= lineEnd) return { text, caret };
  let cursor = caret;
  let next = text;
  for (let i = 0; i < count && cursor < lineEnd; i += 1) {
    const end = nextGraphemeBoundary(next, cursor);
    const slice = next.slice(cursor, end);
    const flipped = slice === slice.toLowerCase() ? slice.toUpperCase() : slice.toLowerCase();
    next = next.slice(0, cursor) + flipped + next.slice(end);
    cursor = end;
  }
  return { text: next, caret: restOnGrapheme(next, cursor) };
}

/**
 * `J`: pulls the following line onto this one, with a single space where the
 * newline was and the caret on that space. Leading blanks on the pulled line go,
 * and a line already ending in a space gains no second one.
 */
export function joinLines(text: string, caret: number, count: number): VimEdit {
  let next = text;
  let cursor = caret;
  const joins = Math.max(1, count - 1);
  for (let i = 0; i < joins; i += 1) {
    const lineEnd = logicalLineEndOffset(next, cursor);
    if (lineEnd >= next.length) break;
    const tail = lineFirstNonBlank(next, lineEnd + 1);
    const separator = lineEnd > 0 && next[lineEnd - 1] === " " ? "" : " ";
    next = next.slice(0, lineEnd) + separator + next.slice(tail);
    cursor = lineEnd;
  }
  return { text: next, caret: restOnGrapheme(next, cursor) };
}

/** `>` and `<` over whole lines. Dedent removes at most one indent per line. */
export function shiftLines(text: string, range: VimRange, direction: "right" | "left"): VimEdit {
  const start = logicalLineStartOffset(text, range.start);
  const end = logicalLineEndOffset(text, Math.max(start, range.end - 1));
  const shifted = text
    .slice(start, end)
    .split("\n")
    .map((line) => (direction === "right" ? indent(line) : dedent(line)))
    .join("\n");
  const next = text.slice(0, start) + shifted + text.slice(end);
  return { text: next, caret: lineFirstNonBlank(next, start) };
}

/**
 * `o` and `O`: opens a blank line and leaves the caret on it. The caret is an
 * insertion point rather than resting on a grapheme, because insert follows.
 */
export function openLine(text: string, caret: number, where: "below" | "above"): VimEdit {
  if (where === "below") {
    const lineEnd = logicalLineEndOffset(text, caret);
    return { text: `${text.slice(0, lineEnd)}\n${text.slice(lineEnd)}`, caret: lineEnd + 1 };
  }
  const start = logicalLineStartOffset(text, caret);
  return { text: `${text.slice(0, start)}\n${text.slice(start)}`, caret: start };
}

function takenFrom(text: string, range: VimRange): VimRegister {
  const slice = text.slice(range.start, range.end);
  // A linewise register always ends in the newline it represents, even when the
  // span borrowed the newline in front of it because the buffer had none behind.
  if (!range.linewise) return { text: slice, linewise: false };
  return { text: linewiseBody(slice), linewise: true };
}

/** A linewise register's text without a leading or trailing newline. */
function linewiseBody(slice: string): string {
  return slice.replace(/^\n/, "").replace(/\n$/, "");
}

function indent(line: string): string {
  return line.length === 0 ? line : INDENT + line;
}

function dedent(line: string): string {
  if (line.startsWith(INDENT)) return line.slice(INDENT.length);
  if (line.startsWith("\t")) return line.slice(1);
  return line.startsWith(" ") ? line.slice(1) : line;
}
