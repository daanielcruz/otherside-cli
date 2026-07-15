import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export const OVERLAY_NAMES = [
  "help",
  "model",
  "effort",
  "agents",
  "tasks",
  "bashes",
  "config",
  "permissions",
  "hooks",
  "diff",
  "skills",
  "status",
  "usage",
  "stats",
  "mcp",
  "login",
  "logout",
  "rewind",
  "resume",
  "theme",
  "remote",
  "design",
  "workflows",
  "ultracode-effort",
  "plugins",
] as const;

export type OverlayName = (typeof OVERLAY_NAMES)[number];
export type Overlay = OverlayName | null;
export type OverlayOpenStack = readonly OverlayName[];

export interface OverlayEntry {
  readonly name: OverlayName;
  readonly props?: unknown;
}

export interface OverlayState {
  readonly openStack: readonly OverlayEntry[];
  readonly pendingChain: readonly OverlayEntry[];
  readonly slices: Readonly<Partial<Record<OverlayName, unknown>>>;
}

const initial: OverlayState = {
  openStack: [],
  pendingChain: [],
  slices: {},
};

export const overlayStore: Store<OverlayState> = makeStore<OverlayState>(initial);

function drainNext(state: OverlayState): OverlayState {
  if (state.openStack.length > 0) return state;
  if (state.pendingChain.length === 0) return state;
  const [head, ...rest] = state.pendingChain;
  if (head === undefined) return state;
  return { ...state, openStack: [head], pendingChain: rest };
}

function removeSliceKey(slices: OverlayState["slices"], name: OverlayName): OverlayState["slices"] {
  if (!(name in slices)) return slices;
  const next = { ...slices };
  delete next[name];
  return next;
}

export const overlayStack = {
  open(name: OverlayName, props?: unknown): void {
    overlayStore.setState((prev) => ({
      ...prev,
      openStack: [...prev.openStack, { name, props }],
    }));
  },

  closeTop(): void {
    overlayStore.setState((prev) => {
      if (prev.openStack.length === 0) return prev;
      const nextStack = prev.openStack.slice(0, -1);
      return drainNext({ ...prev, openStack: nextStack });
    });
  },

  clearSlice(name: OverlayName): void {
    overlayStore.setState((prev) => {
      const next = removeSliceKey(prev.slices, name);
      return next === prev.slices ? prev : { ...prev, slices: next };
    });
  },
};

function selectOpenStack(): readonly OverlayEntry[] {
  return overlayStore.getState().openStack;
}

function selectTop(): OverlayEntry | null {
  const stack = overlayStore.getState().openStack;
  return stack.length === 0 ? null : (stack[stack.length - 1] ?? null);
}

export function useOverlayOpenStack(): readonly OverlayEntry[] {
  return useSyncExternalStore(overlayStore.subscribe, selectOpenStack, selectOpenStack);
}

export function useTopOverlay(): OverlayEntry | null {
  return useSyncExternalStore(overlayStore.subscribe, selectTop, selectTop);
}

export function useOverlaySlice(name: OverlayName): unknown {
  return useSyncExternalStore(
    overlayStore.subscribe,
    () => overlayStore.getState().slices[name],
    () => overlayStore.getState().slices[name],
  );
}
