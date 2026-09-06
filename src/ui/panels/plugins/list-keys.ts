import { createPluginId } from "@/engine/plugins/identity.ts";
import { clampIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { searchKeyTransition } from "@/ui/chrome/panel-search.ts";
import type { InstalledRow } from "@/ui/panels/plugins/installed-rows.ts";
import { findSelectableInstalledRow } from "@/ui/panels/plugins/installed-rows.ts";
import {
  type KeyOutcome,
  outcome,
  SEARCH_POLICY,
  searchState,
} from "@/ui/panels/plugins/panel-keys-support.ts";
import type { PanelModel } from "@/ui/panels/plugins/panel-model.ts";
import { favoriteIdentity } from "@/ui/panels/plugins/panel-model.ts";
import {
  appliedSearchTransition,
  type PanelState,
  resetForTab,
  withDiscover,
  withInstalled,
  withMarketplaces,
  withNav,
} from "@/ui/panels/plugins/panel-state.ts";
import type { DiscoverItem } from "@/ui/panels/plugins/types.ts";

/**
 * Keys belonging to a browse list: cursor movement shared by every tab, then the
 * per-tab activation vocabulary and the row openers it dispatches to.
 */

export function upKey(state: PanelState, key: KeyEventData, model: PanelModel): KeyOutcome {
  if (state.nav.tab === "installed") {
    const next = findSelectableInstalledRow(model.installedRows, model.selectedIndex - 1, -1);
    if (next < 0) return enterSearchFromListTop(state, key);
    return outcome(withNav(state, { selected: next }));
  }
  if (state.nav.tab === "discover" && model.selectedIndex === 0) {
    return enterSearchFromListTop(state, key);
  }
  return outcome(withNav(state, { selected: clampIndex(model.selectedIndex - 1, model.count) }));
}

/** Up from the first list item hands focus to the search box (shared entry policy). */
function enterSearchFromListTop(state: PanelState, key: KeyEventData): KeyOutcome {
  const transition = searchKeyTransition({
    state: searchState(state),
    key,
    policy: SEARCH_POLICY,
    atListTop: true,
  });
  return transition === undefined
    ? outcome(state)
    : outcome(appliedSearchTransition(state, transition));
}

export function downKey(state: PanelState, model: PanelModel): KeyOutcome {
  if (state.nav.tab === "installed") {
    const next = findSelectableInstalledRow(model.installedRows, model.selectedIndex + 1, 1);
    return outcome(next >= 0 ? withNav(state, { selected: next }) : state);
  }
  return outcome(withNav(state, { selected: clampIndex(model.selectedIndex + 1, model.count) }));
}

export function marketplacesListKey(
  state: PanelState,
  key: KeyEventData,
  model: PanelModel,
): KeyOutcome | undefined {
  const ch = key.sequence;
  if (ch === "a" || (panelKey(key) === "confirm" && model.selectedIndex === 0)) {
    return outcome(withMarketplaces(state, { addInput: "" }));
  }
  if (!model.selectedMarketplace) return undefined;
  if (ch === "u" || ch === "U") {
    // From the roster the update outlives the screen it started on, so it reports
    // through the transcript rather than a detail screen that is not open.
    return outcome(state, {
      kind: "update-marketplace",
      source: model.selectedMarketplace.source,
      inDetail: false,
    });
  }
  if (ch === "d" || ch === "D" || ch === "r" || ch === "R") {
    return outcome(withMarketplaces(state, { view: "confirm-remove" }));
  }
  if (panelKey(key) === "confirm") {
    return outcome(withMarketplaces(state, { view: "details", detailsSelection: 0 }));
  }
  return undefined;
}

export function installedListKey(
  state: PanelState,
  key: KeyEventData,
  model: PanelModel,
): KeyOutcome | undefined {
  const row = model.installedRows[model.selectedIndex];
  const ch = key.sequence;
  if (row && (key.name === "space" || ch === " ")) return toggleInstalledRow(state, row);
  if (row && panelKey(key) === "confirm") return openInstalledRow(state, row, model);
  if (row?.kind === "item" && row.item.type === "plugin" && (ch === "f" || ch === "F")) {
    return outcome(state, { kind: "toggle-favorite", plugin: row.item.plugin });
  }
  // `/` focuses the search box; a printable char focuses it and seeds the query.
  const transition = searchKeyTransition({ state: searchState(state), key, policy: SEARCH_POLICY });
  return transition === undefined ? undefined : outcome(appliedSearchTransition(state, transition));
}

export function discoverListKey(
  state: PanelState,
  key: KeyEventData,
  model: PanelModel,
): KeyOutcome | undefined {
  const ch = key.sequence;
  if (ch === "j" || ch === "k") {
    return outcome(
      withNav(state, {
        selected: clampIndex(model.selectedIndex + (ch === "j" ? 1 : -1), model.count),
      }),
    );
  }
  const item = model.discoverFiltered[model.selectedIndex];
  // An installed row is there for the record: it cannot be marked or installed.
  if (item && !item.installed && (key.name === "space" || ch === " ")) {
    const k = `${item.marketplace}:${item.entry.name}`;
    const next = new Set(state.discover.marked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return outcome(withDiscover(state, { marked: next }));
  }
  if (ch === "i" || ch === "I") {
    const selectedItems = (
      state.discover.marked.size > 0
        ? model.discoverFiltered.filter((candidate) =>
            state.discover.marked.has(`${candidate.marketplace}:${candidate.entry.name}`),
          )
        : item === undefined
          ? []
          : [item]
    ).filter((candidate) => !candidate.installed);
    return outcome(state, { kind: "install-batch", items: selectedItems });
  }
  if (item && panelKey(key) === "confirm") {
    if (item.installed) return openInstalledPlugin(state, item, model);
    return outcome(withDiscover(state, { details: item, optionIndex: 0 }));
  }
  // `/` focuses the search box; a printable char focuses it and seeds the query.
  const transition = searchKeyTransition({ state: searchState(state), key, policy: SEARCH_POLICY });
  return transition === undefined ? undefined : outcome(appliedSearchTransition(state, transition));
}

/**
 * Enter on an already-installed browse row hands over to the Installed tab's
 * drill-down for that plugin — the catalogue has nothing left to offer it.
 */
function openInstalledPlugin(
  state: PanelState,
  item: DiscoverItem,
  model: PanelModel,
): KeyOutcome | undefined {
  const identity = createPluginId(item.entry.name, item.marketplace);
  const plugin = model.installed.find((candidate) => favoriteIdentity(candidate) === identity);
  if (!plugin) return undefined;
  const cleared = resetForTab(withDiscover(state, { marketplaceFilter: null }));
  return outcome(
    withInstalled(withNav(cleared, { tab: "installed" }), {
      actionIndex: 0,
      notice: null,
      detail: { kind: "plugin", plugin },
    }),
    { kind: "load-standalone-mcp" },
  );
}

function openInstalledRow(
  state: PanelState,
  row: InstalledRow,
  model: PanelModel,
): KeyOutcome | undefined {
  if (row.kind === "fold") {
    return outcome(withInstalled(state, { showDisabled: !state.installed.showDisabled }));
  }
  if (row.kind !== "item") return undefined;
  const item = row.item;
  if (item.type === "plugin") {
    return outcome(
      withInstalled(state, {
        actionIndex: 0,
        notice: null,
        detail: { kind: "plugin", plugin: item.plugin },
      }),
    );
  }
  if (item.type === "failed-plugin") {
    const errors = model.pluginErrors
      .filter((error) => (error.pluginId ?? "unknown") === item.id)
      .map((error) => ({
        message: error.message,
        ...(error.recoveryHint ? { recoveryHint: error.recoveryHint } : {}),
      }));
    return outcome(
      withInstalled(state, {
        detail: { kind: "failed", name: item.name, marketplace: item.marketplace, errors },
      }),
    );
  }
  if (item.type === "skill") {
    return outcome(withInstalled(state, { skillStateIndex: 0, detail: { kind: "skill", item } }));
  }
  const fullName = item.id.slice("mcp:".length);
  if (item.status === "needs-auth") return outcome(state, { kind: "authenticate-mcp", fullName });
  return outcome(state, { kind: "open-mcp-detail", fullName });
}

function toggleInstalledRow(state: PanelState, row: InstalledRow): KeyOutcome | undefined {
  if (row.kind === "fold") {
    return outcome(withInstalled(state, { showDisabled: !state.installed.showDisabled }));
  }
  if (row.kind !== "item") return undefined;
  const item = row.item;
  if (item.type === "plugin") return outcome(state, { kind: "toggle-plugin", pluginId: item.id });
  if (item.type === "skill") return outcome(state, { kind: "cycle-skill", item });
  if (item.type === "mcp") {
    const fullName = item.id.slice("mcp:".length);
    return outcome(state, {
      kind: "toggle-mcp",
      fullName,
      currentlyEnabled: item.status !== "disabled",
    });
  }
  return undefined;
}
