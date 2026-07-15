export type PaneFocusState = "focused" | "blurred" | "unknown";

let paneState: PaneFocusState = "unknown";
const resolvers: Set<() => void> = new Set();
const focusListeners: Set<() => void> = new Set();

export function setPaneFocused(v: boolean): void {
  paneState = v ? "focused" : "blurred";

  for (const cb of focusListeners) {
    cb();
  }
  if (!v) {
    for (const resolve of resolvers) {
      resolve();
    }
    resolvers.clear();
  }
}

export function getPaneFocused(): boolean {
  return paneState !== "blurred";
}

export function getPaneFocusState(): PaneFocusState {
  return paneState;
}

export function subscribePaneFocus(cb: () => void): () => void {
  focusListeners.add(cb);
  return () => {
    focusListeners.delete(cb);
  };
}

export function resetPaneFocusState(): void {
  paneState = "unknown";
  for (const cb of focusListeners) {
    cb();
  }
}
