import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { searchKeyTransition } from "@/ui/chrome/panel-search.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";
import type { TabId } from "@/ui/panels/config/rows.ts";
import type { Focus } from "@/ui/panels/config/view-rows.ts";

export const CONFIG_TABS: { id: TabId; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "config", label: "Config" },
];

/** Letters that jump straight to a tab from the header or the row list. */
const TAB_JUMP_KEYS: Record<string, TabId> = { d: "details", c: "config" };
const HALF_PAGE_DIVISOR = 2;

export function configTabId(tabIdx: number): TabId {
  return CONFIG_TABS[tabIdx]?.id ?? "config";
}

/** How a key routed through the shared search machine lands on panel state. */
export interface ConfigSearchUpdate {
  query: string;
  cursorOffset: number | undefined;
  focus: Focus | undefined;
  resetRows: boolean;
}

/**
 * Route the key through the shared search machine. Only the config tab has a
 * search box; the tab row above it makes `up` an exit to the header.
 */
export function configSearchKey(
  key: KeyEventData,
  state: { focused: boolean; query: string; cursorOffset: number | undefined },
): ConfigSearchUpdate | undefined {
  const transition = searchKeyTransition({
    state: {
      focused: state.focused,
      query: state.query,
      ...(state.cursorOffset !== undefined ? { cursorOffset: state.cursorOffset } : {}),
    },
    key,
    policy: "slash-only",
    hasHeader: true,
  });
  if (transition === undefined) return undefined;
  let focus: Focus | undefined;
  let resetRows = transition.state.query !== state.query;
  if (transition.state.focused) {
    focus = "search";
  } else if (transition.exitTo === "header") {
    focus = "tabs";
  } else if (transition.exitTo === "list") {
    focus = "body";
    resetRows = true;
  }
  return {
    query: transition.state.query,
    cursorOffset: transition.state.cursorOffset,
    focus,
    resetRows,
  };
}

/**
 * `d`/`c` reach a tab in one press from the header or the list. The search box owns
 * typing, so a focused box never loses a letter to a jump.
 */
export function configTabJump(
  key: KeyEventData,
  activeTabIdx: number,
  focus: Focus,
): { tabIdx: number; focus: Focus } | undefined {
  if (focus === "search" || key.ctrl || key.meta) return undefined;
  const target = TAB_JUMP_KEYS[key.sequence ?? ""];
  if (target === undefined) return undefined;
  const index = CONFIG_TABS.findIndex((tab) => tab.id === target);
  if (index < 0 || index === activeTabIdx) return undefined;
  return { tabIdx: index, focus: target === "config" ? "search" : "tabs" };
}

/** Ctrl+U / Ctrl+D move the row cursor by half of what the list shows. */
export function halfPageRowCursor(
  current: number,
  listRows: number,
  rowCount: number,
  direction: 1 | -1,
): number {
  const step = Math.max(1, Math.floor(listRows / HALF_PAGE_DIVISOR));
  return Math.max(0, Math.min(rowCount - 1, current + direction * step));
}

/** `up` from the list: details tab exits to the header, config tab climbs to search. */
export function configUpKey(state: {
  focus: Focus;
  activeTab: TabId;
  rowIdx: number;
}): { focus?: Focus; rowIdx?: number } | undefined {
  if (state.focus !== "body") return undefined;
  if (state.activeTab === "details") return { focus: "tabs" };
  if (state.rowIdx === 0) return { focus: "search" };
  return { rowIdx: Math.max(0, state.rowIdx - 1) };
}

/** `down` from the header enters the search box; from the list it advances the cursor. */
export function configDownKey(state: {
  focus: Focus;
  activeTab: TabId;
  rowIdx: number;
  rowCount: number;
}): { focus?: Focus; rowIdx?: number } | undefined {
  if (state.focus === "tabs") {
    if (state.activeTab !== "config") return undefined;
    return { focus: "search", rowIdx: 0 };
  }
  if (state.focus !== "body" || state.activeTab === "details") return undefined;
  const max = Math.max(0, state.rowCount - 1);
  return { rowIdx: Math.min(max, state.rowIdx + 1) };
}

export type OutputStyleKeyOutcome =
  | { kind: "commit" }
  | { kind: "cancel" }
  | { kind: "move"; cursor: number };

/** One key inside the style picker, mapped to the cursor or exit that follows. */
export function outputStyleCursorAfterKey(
  cursor: number,
  optionCount: number,
  key: KeyEventData,
): OutputStyleKeyOutcome | undefined {
  // A one-choice list: taking the row and toggling it both commit.
  const panelAction = panelKey(key);
  if (panelAction === "confirm" || panelAction === "toggle") return { kind: "commit" };
  if (panelAction === "close") return { kind: "cancel" };
  const max = Math.max(0, optionCount - 1);
  if (key.name === "up") return { kind: "move", cursor: Math.max(0, cursor - 1) };
  if (key.name === "down") return { kind: "move", cursor: Math.min(max, cursor + 1) };
  return undefined;
}

export type LanguageKeyOutcome =
  | { kind: "commit"; draft: string }
  | { kind: "cancel" }
  | { kind: "edit"; draft: string };

/** One key inside the free-text language editor, mapped to the draft that follows. */
export function languageDraftAfterKey(
  draft: string,
  key: KeyEventData,
): LanguageKeyOutcome | undefined {
  if (key.name === "return") return { kind: "commit", draft: draft.trim() };
  if (key.name === "escape") return { kind: "cancel" };
  if (key.name === "backspace" || key.name === "delete") {
    return { kind: "edit", draft: draft.slice(0, -1) };
  }
  const sequence = key.sequence;
  if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
    return { kind: "edit", draft: draft + sequence };
  }
  return undefined;
}

/**
 * Which way a config row's value steps, or null when the key is not a step.
 *
 * A config row cycles its value rather than opening a level, so the arrows mean
 * something different here than they do in the panel vocabulary — and `config`
 * claims them first, which is exactly what an inner context is for.
 */
export function configStepDirection(key: KeyEventData): 1 | -1 | null {
  const resolved = lookupKey({ key, contexts: ["config"] });
  if (resolved.kind !== "action" || resolved.action !== "config:stepValue") return null;
  return key.name === "left" ? -1 : 1;
}
