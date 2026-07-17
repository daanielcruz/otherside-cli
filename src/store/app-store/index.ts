import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";
import { appReducer } from "@/store/app-store/reducer.ts";
import { initialRightRegionSlice } from "@/store/app-store/slices/right-region.ts";
import { initialUsageSlice } from "@/store/app-store/slices/usage.ts";
import { initialViewSlice } from "@/store/app-store/slices/view.ts";
import type { AppAction, AppDispatch, AppState } from "@/store/app-store/types.ts";

const initialAppState: AppState = {
  engine: {},
  view: initialViewSlice,
  usage: initialUsageSlice,
  rightRegion: initialRightRegionSlice,
};

export const appStore: Store<AppState> = makeStore<AppState>(initialAppState);

export const dispatch: AppDispatch = (action: AppAction): void => {
  appStore.setState((prev) => appReducer(prev, action));
};

export function useApp(): AppState {
  return useSyncExternalStore(appStore.subscribe, appStore.getState, appStore.getState);
}

export function useAppSelect<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    appStore.subscribe,
    () => selector(appStore.getState()),
    () => selector(appStore.getState()),
  );
}
