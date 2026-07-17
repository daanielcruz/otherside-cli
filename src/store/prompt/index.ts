import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export interface PromptSearchState {
  readonly query: string;
  readonly failed: boolean;
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
}

const initial: PromptState = {
  text: "",
  menuOpen: false,
  search: null,
  bashMode: false,
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

export function isPromptSearchOpen(): boolean {
  return promptStore.getState().search !== null;
}

export function usePromptState(): PromptState {
  return useSyncExternalStore(promptStore.subscribe, promptStore.getState, promptStore.getState);
}

export function usePromptSelector<T>(selector: (s: PromptState) => T): T {
  return useSyncExternalStore(
    promptStore.subscribe,
    () => selector(promptStore.getState()),
    () => selector(promptStore.getState()),
  );
}
