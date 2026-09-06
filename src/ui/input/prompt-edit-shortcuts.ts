import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import {
  deleteNextGraphemeEdit,
  deleteNextWordEdit,
  deletePrevGraphemeEdit,
  killPreviousWordEdit,
  killToLineEndEdit,
  killToLineStartEdit,
  type PromptEdit,
  yankEdit,
  yankPopEdit,
} from "@/ui/input/prompt-edit-ops.ts";
import {
  logicalLineEndOffset,
  logicalLineStartOffset,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "@/ui/input/prompt-text.js";
import { lookupKey } from "@/ui/keys/resolver.ts";

export type PromptEditShortcut =
  | { kind: "edit"; edit: PromptEdit | null; keepHistoryRun?: true }
  | { kind: "kill"; edit: PromptEdit | null }
  | { kind: "move"; caret: number }
  | { kind: "history-up" }
  | { kind: "history-down" }
  | { kind: "toggle-keyword" }
  | { kind: "bubble" };

export function effectivePromptKeyName(key: KeyEventData): string | undefined {
  if (key.name) return key.name;
  return /^\x1b([a-z])$/i.exec(key.sequence ?? "")?.[1]?.toLowerCase();
}

export function continuesKillChain(key: KeyEventData, keyName: string | undefined): boolean {
  const kill =
    (key.ctrl && (keyName === "k" || keyName === "u" || keyName === "w")) ||
    ((key.ctrl || key.meta) && keyName === "backspace") ||
    (key.meta && keyName === "delete");
  const yank = (key.ctrl || key.meta) && keyName === "y";
  return kill || yank;
}

export function promptEditShortcut(input: {
  key: KeyEventData;
  keyName: string | undefined;
  text: string;
  caret: number;
  columns: number;
}): PromptEditShortcut | null {
  const { key, text, caret, columns } = input;
  // Editing is innermost in the prompt — the caret is in the buffer — so `edit`
  // answers before `prompt` does.
  const resolved = lookupKey({ key, contexts: ["edit", "prompt"] });
  if (resolved.kind !== "action") return null;
  // An ARROW reaches history only from the edge of the draft: it is a row move
  // first, and the prompt's own vertical path decides when there is no row left.
  // A history CHORD is history immediately, which is the difference between them.
  const arrow = key.name === "up" || key.name === "down";
  switch (resolved.action) {
    case "prompt:historyPrevious":
      return arrow ? null : { kind: "history-up" };
    case "prompt:historyNext":
      return arrow ? null : { kind: "history-down" };
    case "edit:killToLineEnd":
      return { kind: "kill", edit: killToLineEndEdit(text, caret, columns) };
    case "edit:killPreviousWord":
      return { kind: "kill", edit: killPreviousWordEdit(text, caret) };
    case "edit:killToLineStart":
      return { kind: "kill", edit: killToLineStartEdit(text, caret, columns) };
    case "edit:yank":
      return { kind: "edit", edit: yankEdit(text, caret) };
    case "edit:yankPop":
      return { kind: "edit", edit: yankPopEdit(text), keepHistoryRun: true };
    case "edit:deleteNextChar":
      // An empty prompt lets the key bubble: there it means leaving the session,
      // which is the one editing chord that stops being an edit.
      return text.length === 0
        ? { kind: "bubble" }
        : { kind: "edit", edit: deleteNextGraphemeEdit(text, caret) };
    case "edit:deleteNextWord":
      return { kind: "edit", edit: deleteNextWordEdit(text, caret) };
    case "edit:moveLineStart":
      return { kind: "move", caret: logicalLineStartOffset(text, caret) };
    case "edit:moveLineEnd":
      return { kind: "move", caret: logicalLineEndOffset(text, caret) };
    case "edit:deletePreviousChar":
      return { kind: "edit", edit: deletePrevGraphemeEdit(text, caret) };
    case "edit:movePreviousChar":
      return { kind: "move", caret: prevGraphemeBoundary(text, caret) };
    case "edit:moveNextChar":
      return { kind: "move", caret: nextGraphemeBoundary(text, caret) };
    case "prompt:toggleKeyword":
      return { kind: "toggle-keyword" };
    default:
      return null;
  }
}
