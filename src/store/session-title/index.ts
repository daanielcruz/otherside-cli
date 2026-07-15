import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export interface SessionTitleState {
  readonly title: string | null;
  readonly attempted: boolean;
}

const initial: SessionTitleState = { title: null, attempted: false };

export const sessionTitleStore: Store<SessionTitleState> = makeStore<SessionTitleState>(initial);

export function getSessionTitle(): string | null {
  return sessionTitleStore.getState().title;
}

export const sessionTitleActions = {
  setTitle(title: string | null): void {
    sessionTitleStore.setState((prev) => (prev.title === title ? prev : { ...prev, title }));
  },
  setAttempted(attempted: boolean): void {
    sessionTitleStore.setState((prev) =>
      prev.attempted === attempted ? prev : { ...prev, attempted },
    );
  },
  reset(): void {
    sessionTitleStore.setState((prev) => (prev.title === null && !prev.attempted ? prev : initial));
  },
};

export function useSessionTitleState(): SessionTitleState {
  return useSyncExternalStore(
    sessionTitleStore.subscribe,
    sessionTitleStore.getState,
    sessionTitleStore.getState,
  );
}

export function useSessionTitle(): string | null {
  return useSyncExternalStore(
    sessionTitleStore.subscribe,
    () => sessionTitleStore.getState().title,
    () => sessionTitleStore.getState().title,
  );
}
