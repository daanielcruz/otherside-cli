import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

export const OVERLAY_DEFINITIONS = [
  { name: "help", ownsDismiss: false },
  { name: "model", ownsDismiss: false },
  { name: "effort", ownsDismiss: false },
  { name: "agents", ownsDismiss: false },
  { name: "tasks", ownsDismiss: false },
  { name: "bashes", ownsDismiss: false },
  { name: "config", ownsDismiss: false },
  { name: "permissions", ownsDismiss: false },
  { name: "error", ownsDismiss: true },
  { name: "quota", ownsDismiss: true },
  { name: "hooks", ownsDismiss: false },
  { name: "diff", ownsDismiss: false },
  { name: "skills", ownsDismiss: false },
  { name: "status", ownsDismiss: false },
  { name: "usage", ownsDismiss: false },
  { name: "stats", ownsDismiss: false },
  { name: "mcp", ownsDismiss: true },
  { name: "login", ownsDismiss: false },
  { name: "logout", ownsDismiss: false },
  { name: "rewind", ownsDismiss: true },
  { name: "resume", ownsDismiss: true },
  { name: "theme", ownsDismiss: false },
  { name: "remote", ownsDismiss: false },
  { name: "design", ownsDismiss: false },
  { name: "workflows", ownsDismiss: false },
  { name: "ultracode-effort", ownsDismiss: false },
  { name: "plugins", ownsDismiss: true },
  { name: "orchestration", ownsDismiss: true },
  { name: "btw", ownsDismiss: true },
] as const satisfies readonly {
  name: string;
  ownsDismiss: boolean;
}[];

export type OverlayName = (typeof OVERLAY_DEFINITIONS)[number]["name"];

export const OVERLAY_NAMES: readonly OverlayName[] = OVERLAY_DEFINITIONS.map(
  (definition) => definition.name,
);

export function isOverlayName(name: string): name is OverlayName {
  return (OVERLAY_NAMES as readonly string[]).includes(name);
}

export interface OverlayMetadata {
  ownsDismiss: boolean;
}

export const OVERLAY_METADATA: Readonly<Record<OverlayName, OverlayMetadata>> = Object.fromEntries(
  OVERLAY_DEFINITIONS.map((definition) => [
    definition.name,
    { ownsDismiss: definition.ownsDismiss },
  ]),
) as Record<OverlayName, OverlayMetadata>;
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
