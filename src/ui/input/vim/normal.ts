import { logicalLineEndOffset, nextGraphemeBoundary } from "@/ui/input/prompt-text.ts";
import { lineFirstNonBlank } from "@/ui/input/vim/boundaries.ts";
import {
  deleteGrapheme,
  joinLines,
  openLine,
  pasteAfter,
  pasteBefore,
  toggleCase,
  type VimEdit,
} from "@/ui/input/vim/edit.ts";
import type {
  FindStop,
  SearchDirection,
  VimMotion,
  VimOperator,
  VimRegister,
} from "@/ui/input/vim/types.ts";

const emptyRegister = (): VimRegister => ({ text: "", linewise: false });

/**
 * What a printable key means in NORMAL, as far as navigation goes. Answering with
 * a description rather than acting keeps the key table in one readable place and
 * leaves the state — counts, a parked prefix, the last search — to the caller.
 */
export type NormalKey =
  | { kind: "motion"; motion: VimMotion }
  /** A digit joining a count, or `0` as the line-start motion when none is open. */
  | { kind: "digit"; digit: number }
  | { kind: "gPrefix" }
  /** `f F t T`: the direction and stop are known, the target is the next key. */
  | { kind: "awaitFindTarget"; direction: SearchDirection; stop: "on" | "before" }
  /** `;` replays the last search as it was; `,` replays it the other way. */
  | { kind: "repeatFind"; flipped: boolean }
  /**
   * `i I a A`: each carries where insert opens, and whether it is the plain `i` or
   * `a` — the two that double as text-object prefixes once an operator is waiting.
   */
  | {
      kind: "enterInsert";
      at: (text: string, caret: number) => number;
      objectPrefix: "inner" | "around" | null;
    }
  /** `d c y > <`: waits for a motion, or for its own key again to go linewise. */
  | { kind: "operator"; operator: VimOperator }
  /** `D C Y`: the same operators over the rest of the line, no motion needed. */
  | { kind: "operatorToLineEnd"; operator: VimOperator }
  /**
   * A standalone command: `x ~ J o O p P`. Each acts at the caret with a count
   * rather than over a motion's span, and carries the edit it runs so this table
   * decides everything about which and the mode performs only one thing.
   */
  | {
      kind: "caretEdit";
      edit: (text: string, caret: number, count: number) => VimEdit;
      entersInsert: boolean;
      /** False for the edits that put nothing in the register, like `~` and `J`. */
      takes: boolean;
    }
  | { kind: "awaitReplaceTarget" }
  | { kind: "undo" }
  /** `.`: replays the last change wherever the caret now is. */
  | { kind: "repeatChange" }
  | { kind: "unbound" };

const MOTIONS: Record<string, VimMotion> = {
  h: { kind: "charLeft" },
  l: { kind: "charRight" },
  " ": { kind: "charRight" },
  j: { kind: "lineDown" },
  k: { kind: "lineUp" },
  w: { kind: "wordForward", word: "small" },
  W: { kind: "wordForward", word: "big" },
  b: { kind: "wordBackward", word: "small" },
  B: { kind: "wordBackward", word: "big" },
  e: { kind: "wordEnd", word: "small" },
  E: { kind: "wordEnd", word: "big" },
  "^": { kind: "lineFirstNonBlank" },
  $: { kind: "lineEnd" },
  G: { kind: "lastLine" },
};

const FINDS: Record<string, { direction: SearchDirection; stop: "on" | "before" }> = {
  f: { direction: "forward", stop: "on" },
  F: { direction: "backward", stop: "on" },
  t: { direction: "forward", stop: "before" },
  T: { direction: "backward", stop: "before" },
};

const INSERT_ENTRIES: Record<string, NormalKey & { kind: "enterInsert" }> = {
  i: { kind: "enterInsert", at: (_text, caret) => caret, objectPrefix: "inner" },
  I: { kind: "enterInsert", at: lineFirstNonBlank, objectPrefix: null },
  a: { kind: "enterInsert", at: nextGraphemeBoundary, objectPrefix: "around" },
  A: { kind: "enterInsert", at: logicalLineEndOffset, objectPrefix: null },
};

/** What the key that follows a parked `g` means. Anything else clears the prefix. */
const AFTER_G: Record<string, VimMotion> = {
  g: { kind: "firstLine" },
  j: { kind: "displayLineDown" },
  k: { kind: "displayLineUp" },
};

const OPERATORS: Record<string, VimOperator> = {
  d: "delete",
  c: "change",
  y: "yank",
  ">": "shiftRight",
  "<": "shiftLeft",
};

const LINE_TAIL_OPERATORS: Record<string, VimOperator> = {
  D: "delete",
  C: "change",
  Y: "yank",
};

function caretEdit(
  edit: (text: string, caret: number, count: number) => VimEdit,
  options: { entersInsert?: boolean; takes?: boolean } = {},
): NormalKey {
  return {
    kind: "caretEdit",
    edit,
    entersInsert: options.entersInsert === true,
    takes: options.takes === true,
  };
}

/**
 * `p` and `P` repeat by pasting again onto what the previous paste produced, which
 * is what makes `3p` land three copies rather than one.
 */
function repeatedPaste(
  paste: (text: string, caret: number, register: VimRegister) => VimEdit,
  register: () => VimRegister,
): (text: string, caret: number, count: number) => VimEdit {
  return (text, caret, count) => {
    let edit = paste(text, caret, register());
    for (let i = 1; i < count; i += 1) edit = paste(edit.text, edit.caret, register());
    return edit;
  };
}

function standalones(register: () => VimRegister): Record<string, NormalKey> {
  return {
    x: caretEdit(deleteGrapheme, { takes: true }),
    "~": caretEdit(toggleCase),
    J: caretEdit(joinLines),
    r: { kind: "awaitReplaceTarget" },
    o: caretEdit((text, caret) => openLine(text, caret, "below"), { entersInsert: true }),
    O: caretEdit((text, caret) => openLine(text, caret, "above"), { entersInsert: true }),
    p: caretEdit(repeatedPaste(pasteAfter, register)),
    P: caretEdit(repeatedPaste(pasteBefore, register)),
    u: { kind: "undo" },
    ".": { kind: "repeatChange" },
  };
}

/**
 * What a key means in NORMAL. The register is read lazily, so a paste picks up
 * whatever is in it when the key is pressed rather than when the table was built.
 */
export function classifyNormalKey(
  typed: string,
  register: () => VimRegister = emptyRegister,
): NormalKey {
  const digit = digitValue(typed);
  if (digit !== null) return { kind: "digit", digit };
  const motion = MOTIONS[typed];
  if (motion) return { kind: "motion", motion };
  const find = FINDS[typed];
  if (find) return { kind: "awaitFindTarget", direction: find.direction, stop: find.stop };
  if (typed === ";") return { kind: "repeatFind", flipped: false };
  if (typed === ",") return { kind: "repeatFind", flipped: true };
  if (typed === "g") return { kind: "gPrefix" };
  const operator = OPERATORS[typed];
  if (operator) return { kind: "operator", operator };
  const lineTail = LINE_TAIL_OPERATORS[typed];
  if (lineTail) return { kind: "operatorToLineEnd", operator: lineTail };
  const standalone = standalones(register)[typed];
  if (standalone) return standalone;
  const insert = INSERT_ENTRIES[typed];
  if (insert) return insert;
  return { kind: "unbound" };
}

/** The key that doubles an operator into a linewise one: `dd`, `cc`, `>>`. */
export function doublesOperator(typed: string, operator: VimOperator): boolean {
  return OPERATORS[typed] === operator;
}

/** The motion a key completes after a parked `g`, or null when nothing does. */
export function motionAfterGPrefix(typed: string): VimMotion | null {
  return AFTER_G[typed] ?? null;
}

function digitValue(typed: string): number | null {
  if (typed.length !== 1 || typed < "0" || typed > "9") return null;
  return typed.charCodeAt(0) - 48;
}

/**
 * What the key after an operator does. The operator is already known, so this only
 * answers what completes it, parks it one more step, or abandons it.
 */
export type OperatorStep =
  /** A motion completes the operator over the span it covers. */
  | { kind: "motion"; motion: VimMotion }
  /** The operator's own key again: whole lines. */
  | { kind: "lines" }
  /** `;` or `,` completes it with the last search, replayed or flipped. */
  | { kind: "repeatFind"; flipped: boolean }
  /** A digit joining the count the operator will use. */
  | { kind: "digit"; digit: number }
  /** One more key is needed: a `g`, a search target, or a text object. */
  | {
      kind: "park";
      park:
        | "gPrefix"
        | { find: { direction: SearchDirection; stop: FindStop } }
        | { objectAround: boolean };
    }
  | { kind: "abandon" };

export function operatorStep(typed: string, operator: VimOperator): OperatorStep {
  if (doublesOperator(typed, operator)) return { kind: "lines" };
  const classified = classifyNormalKey(typed);
  switch (classified.kind) {
    case "motion":
      return { kind: "motion", motion: classified.motion };
    case "digit":
      return { kind: "digit", digit: classified.digit };
    case "repeatFind":
      return { kind: "repeatFind", flipped: classified.flipped };
    case "gPrefix":
      return { kind: "park", park: "gPrefix" };
    case "awaitFindTarget":
      return {
        kind: "park",
        park: { find: { direction: classified.direction, stop: classified.stop } },
      };
    case "enterInsert":
      // After an operator, `i` and `a` describe an object rather than entering
      // insert. `I` and `A` are not object prefixes at all.
      return classified.objectPrefix === null
        ? { kind: "abandon" }
        : { kind: "park", park: { objectAround: classified.objectPrefix === "around" } };
    default:
      // Vim is equally unforgiving here: guessing a motion from an unrelated key
      // is worse than doing nothing.
      return { kind: "abandon" };
  }
}
