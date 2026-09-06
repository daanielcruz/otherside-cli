import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";
import type { HistoryScope } from "@/kernel/std/types/history-scope.ts";

export interface PromptSearchState {
  readonly query: string;
  readonly failed: boolean;
  /** How wide the search is looking, so the chip can say. */
  readonly scope: HistoryScope;
}

export interface PromptState {
  readonly text: string;
  readonly menuOpen: boolean;
  // Non-null while the prompt's history search owns the keyboard; the status
  // line renders it and the global cancel keys yield to the prompt.
  readonly search: PromptSearchState | null;
  // True while the prompt is in `!` bash input mode; the footer renders the
  // "! for shell mode" hint from this.
  readonly bashMode: boolean;
  /**
   * The reader turned this draft's keyword off. Per draft, not per session: the
   * next prompt is a new question and starts opted in again.
   */
  readonly keywordDismissed: boolean;
  // A collapsed text paste temporarily takes over the footer's left slot.
  readonly pasteExpandHint: boolean;
  // A short-lived line the prompt speaks on the status row: what a gesture just did
  // (a stash, a restore) or what a second press of the same key would do.
  readonly notice: string | null;
  /**
   * How the editor mode announces itself — `-- INSERT --` and friends — or null
   * when there is nothing to announce. The prompt owns the mode and publishes it
   * here; the status row paints it ahead of its standing content.
   */
  readonly editorMode: string | null;
}

const initial: PromptState = {
  text: "",
  menuOpen: false,
  search: null,
  bashMode: false,
  keywordDismissed: false,
  pasteExpandHint: false,
  notice: null,
  editorMode: null,
};

export const promptStore: Store<PromptState> = makeStore<PromptState>(initial);

export function getPromptText(): string {
  return promptStore.getState().text;
}

export function setPromptText(text: string): void {
  promptStore.setState((prev) => (prev.text === text ? prev : { ...prev, text }));
}

export function setPromptMenuOpen(menuOpen: boolean): void {
  promptStore.setState((prev) => (prev.menuOpen === menuOpen ? prev : { ...prev, menuOpen }));
}

export function setPromptSearch(search: PromptSearchState | null): void {
  promptStore.setState((prev) => (prev.search === search ? prev : { ...prev, search }));
}

export function setPromptBashMode(bashMode: boolean): void {
  promptStore.setState((prev) => (prev.bashMode === bashMode ? prev : { ...prev, bashMode }));
}

export function setPromptKeywordDismissed(keywordDismissed: boolean): void {
  promptStore.setState((prev) =>
    prev.keywordDismissed === keywordDismissed ? prev : { ...prev, keywordDismissed },
  );
}

export function setPromptPasteExpandHint(pasteExpandHint: boolean): void {
  promptStore.setState((prev) =>
    prev.pasteExpandHint === pasteExpandHint ? prev : { ...prev, pasteExpandHint },
  );
}

export function setPromptNotice(notice: string | null): void {
  promptStore.setState((prev) => (prev.notice === notice ? prev : { ...prev, notice }));
}

export function setPromptEditorMode(editorMode: string | null): void {
  promptStore.setState((prev) => (prev.editorMode === editorMode ? prev : { ...prev, editorMode }));
}

export function isPromptSearchOpen(): boolean {
  return promptStore.getState().search !== null;
}

/**
 * True while the command menu owns the rows under the prompt. Every surface that
 * lives there reads this, so the menu never has to share those rows with chrome.
 */
export function isPromptMenuOpen(): boolean {
  return promptStore.getState().menuOpen;
}
