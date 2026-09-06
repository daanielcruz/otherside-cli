import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

/** Whether the terminal window currently has the user's attention. */
export interface WindowAttention {
  readonly active: boolean;
}

// Focus reporting is optional. Assume attention until the terminal explicitly says
// otherwise, so unsupported terminals do not leave attention-sensitive UI dimmed.
const DEFAULT_ATTENTION: WindowAttention = { active: true };

export const windowAttentionStore: Store<WindowAttention> =
  makeStore<WindowAttention>(DEFAULT_ATTENTION);

export function reportWindowAttention(active: boolean): void {
  windowAttentionStore.setState((current) => (current.active === active ? current : { active }));
}

export function windowHasAttention(): boolean {
  return windowAttentionStore.getState().active;
}
