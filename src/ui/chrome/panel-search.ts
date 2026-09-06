import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { isInsertable } from "@/ui/chrome/key-input.ts";

/**
 * The one search state machine for panel search boxes. Rendering is already
 * shared (`searchBoxLines` in the panel builder); this module owns entry and
 * in-search key transitions so every adopting panel searches the same way.
 */

const SEARCH_ENTRY_POLICIES = ["slash-and-typing-seeds", "slash-only"] as const;

/**
 * How a panel enters search from the list:
 * - `slash-and-typing-seeds`: `/` focuses the box, any printable char focuses it
 *   and seeds the query with that char, and `up` from the first list item enters.
 * - `slash-only`: only `/` focuses the box.
 */
export type SearchEntryPolicy = (typeof SEARCH_ENTRY_POLICIES)[number];

export interface PanelSearchState {
  focused: boolean;
  query: string;
  /** Caret position in code points; absent means end-of-query. */
  cursorOffset?: number;
}

export function searchCaretOf(state: Pick<PanelSearchState, "query" | "cursorOffset">): number {
  const length = [...state.query].length;
  const offset = state.cursorOffset ?? length;
  return Math.max(0, Math.min(length, offset));
}

export interface PanelSearchTransition {
  state: PanelSearchState;
  /** Where focus lands when the key moves it out of the search box. */
  exitTo?: "list" | "header";
}

/**
 * Answer the next search state for a key, or undefined when the key is not the
 * machine's business (the panel falls through to its own handling). While the
 * box is focused: Enter and down hand focus to the list, up hands it to the
 * header when one exists, Esc clears the query first and a second Esc exits,
 * and backspace on an empty query exits.
 */
export function searchKeyTransition(input: {
  state: PanelSearchState;
  key: KeyEventData;
  policy: SearchEntryPolicy;
  /** Whether the list cursor sits on its first item (enables up-entry). */
  atListTop?: boolean;
  /** Whether a tab header sits above the search box (enables up-exit). */
  hasHeader?: boolean;
}): PanelSearchTransition | undefined {
  const { state, key } = input;
  return state.focused
    ? focusedTransition(state, key, input.hasHeader ?? false)
    : entryTransition(input);
}

function focusedTransition(
  state: PanelSearchState,
  key: KeyEventData,
  hasHeader: boolean,
): PanelSearchTransition | undefined {
  const chars = [...state.query];
  const caret = searchCaretOf(state);
  if (key.name === "escape") {
    if (state.query.length > 0) return { state: { focused: true, query: "" } };
    return { state: { focused: false, query: "" }, exitTo: "list" };
  }
  if (key.name === "return" || key.name === "down") {
    return { state: { ...state, focused: false }, exitTo: "list" };
  }
  if (key.name === "up") {
    if (!hasHeader) return { state };
    return { state: { ...state, focused: false }, exitTo: "header" };
  }
  if (key.name === "left") {
    return { state: { ...state, cursorOffset: Math.max(0, caret - 1) } };
  }
  if (key.name === "right") {
    return { state: { ...state, cursorOffset: Math.min(chars.length, caret + 1) } };
  }
  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    return { state: { ...state, cursorOffset: 0 } };
  }
  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    return { state: { ...state, cursorOffset: chars.length } };
  }
  if (key.name === "backspace") {
    if (state.query.length === 0) return { state: { focused: false, query: "" }, exitTo: "list" };
    if (caret === 0) return { state };
    const query = [...chars.slice(0, caret - 1), ...chars.slice(caret)].join("");
    return { state: { focused: true, query, cursorOffset: caret - 1 } };
  }
  if (key.name === "delete") {
    if (state.query.length === 0) return { state: { focused: false, query: "" }, exitTo: "list" };
    if (caret >= chars.length) return { state };
    const query = [...chars.slice(0, caret), ...chars.slice(caret + 1)].join("");
    return { state: { focused: true, query, cursorOffset: caret } };
  }
  const sequence = key.sequence;
  if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
    const query = [...chars.slice(0, caret), sequence, ...chars.slice(caret)].join("");
    return { state: { focused: true, query, cursorOffset: caret + [...sequence].length } };
  }
  return undefined;
}

function entryTransition(input: {
  state: PanelSearchState;
  key: KeyEventData;
  policy: SearchEntryPolicy;
  atListTop?: boolean;
}): PanelSearchTransition | undefined {
  const { state, key, policy } = input;
  if (key.ctrl || key.meta) return undefined;
  if (key.sequence === "/") return { state: { focused: true, query: state.query } };
  if (policy !== "slash-and-typing-seeds") return undefined;
  if (key.name === "up" && (input.atListTop ?? false)) {
    return { state: { focused: true, query: state.query } };
  }
  const sequence = key.sequence;
  if (sequence !== undefined && isInsertable(sequence)) {
    return { state: { focused: true, query: state.query + sequence } };
  }
  return undefined;
}
