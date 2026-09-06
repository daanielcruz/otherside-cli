import { nextGraphemeBoundary } from "@/ui/input/prompt-text.ts";
import {
  joinSpan,
  pasteOverSpan,
  runOperator,
  toggleCaseSpan,
  type VimEdit,
} from "@/ui/input/vim/edit.ts";
import { lineSpan } from "@/ui/input/vim/motion.ts";
import { classifyNormalKey } from "@/ui/input/vim/normal.ts";
import type { VimOperator, VimRange, VimRegister, VisualSpan } from "@/ui/input/vim/types.ts";

/**
 * What a visual selection covers and what its keys mean. The selection itself is
 * two offsets — where it was started and where the caret has since travelled —
 * so every motion the mode already resolves also moves a selection edge without
 * knowing that it does.
 */

/**
 * The span between the anchor and the caret. Characterwise covers the caret's own
 * grapheme, which is why a fresh selection of one character is not empty;
 * linewise widens to the whole lines the two ends touch.
 */
export function selectionRange(
  text: string,
  anchor: number,
  caret: number,
  span: VisualSpan,
): VimRange {
  const from = Math.min(anchor, caret);
  const to = Math.max(anchor, caret);
  if (span === "linewise") return lineSpan(text, from, to);
  return {
    start: from,
    end: Math.min(nextGraphemeBoundary(text, to), text.length),
    linewise: false,
  };
}

/**
 * What a printable key does in VISUAL. An edit arrives as the function to run over
 * the selection rather than as a name to look up, so the mode's dispatch performs
 * one thing and this table decides everything about which.
 */
export type VisualAction =
  /** Runs over the selection, then leaves the mode as every visual edit does. */
  | { kind: "edit"; edit: (text: string, range: VimRange) => VimEdit; entersInsert: boolean }
  /** `v` and `V`: a different span switches to it, the same span leaves. */
  | { kind: "span"; span: VisualSpan }
  /** `o`: the caret and the anchor trade places, so the other edge can move. */
  | { kind: "swapEnds" }
  | { kind: "awaitReplaceTarget" }
  /** `i` and `a`: widen the selection to a text object. */
  | { kind: "awaitObject"; around: boolean }
  /** Motions, counts, prefixes and searches keep their NORMAL meaning here. */
  | { kind: "shareWithNormal" }
  | { kind: "ignored" };

const OPERATORS: Record<string, VimOperator> = {
  d: "delete",
  x: "delete",
  c: "change",
  s: "change",
  y: "yank",
  ">": "shiftRight",
  "<": "shiftLeft",
};

const SHARED_WITH_NORMAL = new Set(["motion", "digit", "gPrefix", "awaitFindTarget", "repeatFind"]);

export function visualAction(typed: string, register: VimRegister): VisualAction {
  const operator = OPERATORS[typed];
  if (operator) {
    return {
      kind: "edit",
      edit: (text, range) => runOperator(operator, text, range),
      entersInsert: operator === "change",
    };
  }
  if (typed === "v") return { kind: "span", span: "characterwise" };
  if (typed === "V") return { kind: "span", span: "linewise" };
  if (typed === "o") return { kind: "swapEnds" };
  if (typed === "~" || typed === "u" || typed === "U") {
    return { kind: "edit", edit: toggleCaseSpan, entersInsert: false };
  }
  if (typed === "J") return { kind: "edit", edit: joinSpan, entersInsert: false };
  if (typed === "r") return { kind: "awaitReplaceTarget" };
  if (typed === "p" || typed === "P") {
    return {
      kind: "edit",
      edit: (text, range) => pasteOverSpan(text, range, register),
      entersInsert: false,
    };
  }
  if (typed === "i") return { kind: "awaitObject", around: false };
  if (typed === "a") return { kind: "awaitObject", around: true };
  if (SHARED_WITH_NORMAL.has(classifyNormalKey(typed).kind)) return { kind: "shareWithNormal" };
  return { kind: "ignored" };
}

/** The keys that enter VISUAL from NORMAL, and the span each starts in. */
export function visualEntry(typed: string): VisualSpan | null {
  if (typed === "v") return "characterwise";
  if (typed === "V") return "linewise";
  return null;
}
