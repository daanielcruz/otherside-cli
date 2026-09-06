import type { PasteStore } from "@/kernel/std/types/paste.ts";
import { beginYank, latestKill, nextYankPop, recordKill } from "@/ui/input/kill-ring.ts";
import {
  joinWithLeadingSpace,
  refEndingAt,
  refStartingAt,
  shouldCollapsePastedText,
  snapOutOfRef,
  textRefEndingAt,
} from "@/ui/input/paste/references.ts";
import {
  deleteToVisualLineEnd,
  deleteToVisualLineStart,
  nextGraphemeBoundary,
  nextWordBoundary,
  prevGraphemeBoundary,
  prevWordBoundary,
} from "@/ui/input/prompt-text.js";

/**
 * Buffer edits as data: every operation takes the current text and caret and
 * returns the next pair, or null when the edit does not apply. Kill-ring
 * bookkeeping happens here because it is part of each edit's meaning; the
 * prompt component applies the result and owns everything reactive.
 */

export interface PromptEdit {
  text: string;
  caret: number;
}

export function killPreviousWordEdit(text: string, caret: number): PromptEdit | null {
  const start = snapOutOfRef(text, prevWordBoundary(text, caret), "start");
  if (start === caret) return null;
  recordKill(text.slice(start, caret), "prepend");
  return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

export function killToLineStartEdit(
  text: string,
  caret: number,
  columns: number,
): PromptEdit | null {
  if (caret === 0) return null;
  const edit = deleteToVisualLineStart(text, caret, columns);
  recordKill(edit.killed, "prepend");
  return { text: edit.text, caret: edit.cursor };
}

export function killToLineEndEdit(text: string, caret: number, columns: number): PromptEdit | null {
  if (caret === text.length) return null;
  const edit = deleteToVisualLineEnd(text, caret, columns);
  recordKill(edit.killed, "append");
  return { text: edit.text, caret: edit.cursor };
}

export function yankEdit(text: string, caret: number): PromptEdit | null {
  const killed = latestKill();
  if (killed.length === 0) return null;
  beginYank(caret, killed.length);
  return { text: text.slice(0, caret) + killed + text.slice(caret), caret: caret + killed.length };
}

export function yankPopEdit(text: string): PromptEdit | null {
  const replacement = nextYankPop();
  if (replacement === null) return null;
  const end = replacement.start + replacement.length;
  return {
    text: text.slice(0, replacement.start) + replacement.text + text.slice(end),
    caret: replacement.start + replacement.text.length,
  };
}

export function deleteNextWordEdit(text: string, caret: number): PromptEdit | null {
  const end = snapOutOfRef(text, nextWordBoundary(text, caret), "end");
  if (end === caret) return null;
  return { text: text.slice(0, caret) + text.slice(end), caret };
}

export function deletePrevGraphemeEdit(text: string, caret: number): PromptEdit | null {
  if (caret === 0) return null;
  const reference = refEndingAt(text, caret);
  const start = reference?.start ?? prevGraphemeBoundary(text, caret);
  return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

export function deleteNextGraphemeEdit(text: string, caret: number): PromptEdit | null {
  if (caret >= text.length) return null;
  const reference = refStartingAt(text, caret);
  const end = reference?.end ?? nextGraphemeBoundary(text, caret);
  return { text: text.slice(0, caret) + text.slice(end), caret };
}

export interface PasteEdit extends PromptEdit {
  /** True when the payload collapsed into a placeholder the user can expand. */
  collapsed: boolean;
}

/**
 * Where normalized pasted text lands: replacing the placeholder it re-pastes,
 * collapsing into a fresh placeholder when it would flood the viewport, or
 * inline. Returns null only for an empty payload.
 */
export function pasteEdit(
  text: string,
  caret: number,
  data: string,
  store: PasteStore | null,
  terminalRows: number,
): PasteEdit | null {
  if (data.length === 0) return null;
  const previousPaste = textRefEndingAt(text, caret);
  if (previousPaste !== null) {
    const stored = store?.get(previousPaste.id);
    if (stored?.type === "text" && stored.content === data) {
      return {
        text: text.slice(0, previousPaste.start) + data + text.slice(previousPaste.end),
        caret: previousPaste.start + data.length,
        collapsed: false,
      };
    }
  }
  if (store && shouldCollapsePastedText(data, terminalRows)) {
    const { placeholder } = store.add({ type: "text", content: data });
    const { next, insertedLength } = joinWithLeadingSpace(text, caret, placeholder);
    return { text: next, caret: caret + insertedLength, collapsed: true };
  }
  return {
    text: text.slice(0, caret) + data + text.slice(caret),
    caret: caret + data.length,
    collapsed: false,
  };
}
