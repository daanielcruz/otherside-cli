import type { PanelModel } from "@/ui/panels/plugins/panel-model.ts";
import type { PanelEffect, PanelState } from "@/ui/panels/plugins/panel-state.ts";

/**
 * Reads the model for the state it is handed, returning the state the read
 * settled (clamped cursor, window starts) together with the projection. The
 * host owns the actual build so the key layer stays free of registry imports.
 */
export type PanelModelReader = (state: PanelState) => {
  state: PanelState;
  model: PanelModel;
};

/** How the panel's search boxes enter and leave focus. */
export const SEARCH_POLICY = "slash-and-typing-seeds";

/** One key resolved: the state that follows it and any effect the async side runs. */
export interface KeyOutcome {
  state: PanelState;
  effects?: PanelEffect[];
}

export function outcome(state: PanelState, ...effects: PanelEffect[]): KeyOutcome {
  return effects.length > 0 ? { state, effects } : { state };
}

/** The slice of state the shared search machine reads, in the shape it expects. */
export function searchState(state: PanelState): {
  focused: boolean;
  query: string;
  cursorOffset?: number;
} {
  return {
    focused: state.search.focused,
    query: state.search.query,
    ...(state.search.cursorOffset !== undefined ? { cursorOffset: state.search.cursorOffset } : {}),
  };
}

/** Only two tabs carry a search box; the third never claims a printable key. */
export function hasSearch(state: PanelState): boolean {
  return state.nav.tab === "discover" || state.nav.tab === "installed";
}
