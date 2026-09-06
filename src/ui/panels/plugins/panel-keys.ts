import { clampIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { searchKeyTransition } from "@/ui/chrome/panel-search.ts";
import { cycleTabForKey } from "@/ui/chrome/panel-tabs.ts";
import {
  addMarketplaceKey,
  discoverDetailsKey,
  installedDetailKey,
  marketplaceSubKey,
} from "@/ui/panels/plugins/detail-keys.ts";
import {
  discoverListKey,
  downKey,
  installedListKey,
  marketplacesListKey,
  upKey,
} from "@/ui/panels/plugins/list-keys.ts";
import {
  hasSearch,
  type KeyOutcome,
  outcome,
  type PanelModelReader,
  SEARCH_POLICY,
  searchState,
} from "@/ui/panels/plugins/panel-keys-support.ts";
import {
  appliedSearchTransition,
  backInstalledDetail,
  type PanelState,
  resetForTab,
  searchEngaged,
  withDiscover,
  withMarketplaces,
  withNav,
} from "@/ui/panels/plugins/panel-state.ts";
import { TABS } from "@/ui/panels/plugins/types.ts";

/**
 * The whole key surface as one pure step: `(state, key, model) → outcome`.
 * `undefined` means the key changed nothing — the host neither repaints nor
 * runs an effect. The model reader defers the registry read to the branches
 * that actually need one, matching the build-on-demand the panel always had.
 */
export function panelKeyStep(
  state: PanelState,
  key: KeyEventData,
  readModel: PanelModelReader,
): KeyOutcome | undefined {
  if (state.marketplaces.addInput !== null) return addMarketplaceKey(state, key);

  if (panelKey(key) === "close") return cancelKey(state, key, readModel);

  if (state.nav.tab === "discover" && state.discover.details) {
    return discoverDetailsKey(state, key);
  }
  if (state.nav.tab === "installed" && state.installed.detail.kind !== "list") {
    return installedDetailKey(state, key);
  }
  if (state.nav.tab === "marketplaces" && state.marketplaces.view !== "list") {
    return marketplaceSubKey(state, key, readModel);
  }

  // Tab cycling stays live while the search box is empty — only a box holding
  // text claims tab/←/→ for itself. A switch drops the box's focus with the
  // rest of the per-tab state.
  const nextTab = cycleTabForKey({
    key,
    activeTab: TABS.indexOf(state.nav.tab),
    tabCount: TABS.length,
    headerFocused: !searchEngaged(state),
  });
  if (nextTab !== undefined) {
    const switched = resetForTab(
      withNav(withDiscover(state, { marketplaceFilter: null }), { tab: TABS[nextTab]! }),
    );
    return switched.nav.tab === "installed"
      ? outcome(switched, { kind: "load-standalone-mcp" })
      : outcome(switched);
  }

  if (hasSearch(state) && state.search.focused) {
    // The focused box swallows keys the shared machine declines (arrows, paging).
    const transition = searchKeyTransition({
      state: searchState(state),
      key,
      policy: SEARCH_POLICY,
    });
    return transition === undefined
      ? outcome(state)
      : outcome(appliedSearchTransition(state, transition));
  }

  const { state: clamped, model } = readModel(state);

  if (
    (key.name === "pageup" || key.name === "pagedown") &&
    model.listVisible &&
    clamped.nav.tab !== "installed"
  ) {
    const direction = key.name === "pagedown" ? 1 : -1;
    return outcome(
      withNav(clamped, {
        selected: clampIndex(
          model.selectedIndex + direction * model.browseWindow.size,
          model.count,
        ),
      }),
    );
  }

  if (key.name === "up") return upKey(clamped, key, model);
  if (key.name === "down") return downKey(clamped, model);

  if (clamped.nav.tab === "marketplaces") return marketplacesListKey(clamped, key, model);
  if (clamped.nav.tab === "installed") return installedListKey(clamped, key, model);
  if (clamped.nav.tab === "discover") return discoverListKey(clamped, key, model);
  return undefined;
}

/**
 * The panel's Esc ladder: detail views step back to their list, a focused
 * search hands Esc to the shared machine (clear the query, then exit), and a
 * bare list closes the panel.
 */
function cancelKey(state: PanelState, key: KeyEventData, readModel: PanelModelReader): KeyOutcome {
  if (state.nav.tab === "discover" && state.discover.details) {
    return outcome(withDiscover(state, { details: null, optionIndex: 0 }));
  }
  if (state.nav.tab === "installed" && state.installed.detail.kind !== "list") {
    return outcome(backInstalledDetail(state));
  }
  if (hasSearch(state) && state.search.focused) {
    const transition = searchKeyTransition({
      state: searchState(state),
      key,
      policy: SEARCH_POLICY,
    });
    if (transition !== undefined) return outcome(appliedSearchTransition(state, transition));
  }
  if (state.nav.tab === "marketplaces" && state.marketplaces.view !== "list") {
    return outcome(withMarketplaces(state, { view: "list", detailsSelection: 0 }));
  }
  if (state.nav.tab === "discover" && state.discover.marketplaceFilter !== null) {
    return outcome(marketplaceDetailFor(state, state.discover.marketplaceFilter, readModel));
  }
  return outcome(state, { kind: "close" });
}

/** Back out of a marketplace browse onto the detail screen that opened it. */
function marketplaceDetailFor(
  state: PanelState,
  name: string,
  readModel: PanelModelReader,
): PanelState {
  const { model } = readModel(state);
  const index = model.marketplaces.findIndex((marketplace) => marketplace.name === name);
  if (index < 0) return withDiscover(state, { marketplaceFilter: null });
  const cleared = resetForTab(withDiscover(state, { marketplaceFilter: null }));
  // Item 0 of the marketplaces list is the add action, so entries start at 1.
  return withMarketplaces(withNav(cleared, { tab: "marketplaces", selected: index + 1 }), {
    view: "details",
    detailsSelection: 0,
  });
}
