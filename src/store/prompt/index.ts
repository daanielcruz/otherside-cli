import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export interface PromptState {
  readonly text: string;
  readonly menuOpen: boolean;
}

const initial: PromptState = {
  text: "",
  menuOpen: false,
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
