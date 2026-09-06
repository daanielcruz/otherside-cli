import { createPluginId } from "@/engine/plugins/identity.ts";
import {
  findPluginInstallation,
  listPluginInstallations,
  type PluginInstallScope,
} from "@/engine/plugins/installations.ts";
import { type LoadedPlugin, loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import { listMarketplacePlugins } from "@/engine/plugins/marketplace.ts";
import { listAvailableMarketplaces } from "@/engine/plugins/marketplaces-store.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { getSnapshot } from "@/engine/plugins/state.ts";
import { isPluginDisused, pluginDisuse, pluginUseCount } from "@/engine/plugins/usage.ts";
import { skillStateFor } from "@/engine/skills/overrides.ts";
import { list as listSkills } from "@/engine/skills/registry.ts";
import { skillUseFor } from "@/engine/skills/usage.ts";
import { mcpServerStatuses } from "@/kernel/mcp/client/registry.ts";
import { computeItemCountWindow, computeRowBudgetWindow } from "@/kernel/std/list-window.ts";
import { clampIndex } from "@/kernel/std/math.ts";
import { footerPanelBodyBudget } from "@/ui/chrome/string-view-panel.ts";
import {
  CONTENT_PAD,
  discoverInputGuideLines,
  installedInputGuideLines,
  pluginListFooterSpec,
} from "@/ui/panels/plugins/chrome.ts";
import {
  buildInstalledRows,
  filterInstalledItems,
  findSelectableInstalledRow,
  type InstalledItem,
  isSelectableInstalledRow,
  sortInstalledItems,
} from "@/ui/panels/plugins/installed-rows.ts";
import type { PanelState } from "@/ui/panels/plugins/panel-state.ts";
import { withNav } from "@/ui/panels/plugins/panel-state.ts";
import { skillSourceLabel, skillTokenEstimate } from "@/ui/panels/plugins/skill-detail.ts";
import type { DiscoverItem } from "@/ui/panels/plugins/types.ts";

/** Maximum items visible in the discover and marketplaces windows. */
export const BROWSE_VISIBLE_COUNT = 5;
/** Maximum rows visible in the installed window. */
export const INSTALLED_VISIBLE_COUNT = 8;

const DISCOVER_ITEM_ROWS = 3;
const MARKETPLACE_ACTION_ROWS = 2;
const MARKETPLACE_ITEM_ROWS = 4;
const LIST_GUIDE_MARGIN_ROWS = 1;

export interface PanelViewport {
  width: number;
  terminalRows: number;
}

/** Installed rows are grouped by how widely the install reaches, narrowest first. */
const INSTALL_SCOPE_RANK: Record<PluginInstallScope, number> = {
  project: 0,
  local: 1,
  user: 2,
};

export function favoriteIdentity(plugin: LoadedPlugin): string {
  return plugins.pluginIdForPlugin(plugin);
}

function installScopeRank(scope: PluginInstallScope | undefined): number {
  return INSTALL_SCOPE_RANK[scope ?? "user"];
}

interface PanelListWindow {
  from: number;
  to: number;
  size: number;
  above: number;
  below: number;
  markerAbove: string | undefined;
  markerBelow: string | undefined;
  counter: string;
}

function panelListSlice(input: {
  window: { from: number; to: number; above: number; below: number };
  cursor: number;
  total: number;
}): PanelListWindow {
  const { window } = input;
  const position = input.total === 0 ? 0 : clampIndex(input.cursor, input.total) + 1;
  return {
    ...window,
    size: window.to - window.from,
    markerAbove: window.above > 0 ? " ↑ more above" : undefined,
    markerBelow: window.below > 0 ? " ↓ more below" : undefined,
    counter: `(${position}/${input.total})`,
  };
}

function frameBodyRows(input: Parameters<typeof pluginListFooterSpec>[0], width: number): number {
  const frame = pluginListFooterSpec(input);
  return Math.max(1, footerPanelBodyBudget(frame, input.maxRows, width) - frame.body.length);
}

interface ListWindowInput {
  state: PanelState;
  pluginErrorCount: number;
  total: number;
  cursor: number;
  viewport: PanelViewport;
}

function discoverListSlice(input: ListWindowInput): PanelListWindow {
  const { state, pluginErrorCount, total, cursor, viewport } = input;
  const contentWidth = Math.max(1, viewport.width - CONTENT_PAD * 2);
  const bodyRows = frameBodyRows(
    {
      state,
      pluginErrorCount,
      maxRows: viewport.terminalRows,
      body: [],
    },
    viewport.width,
  );
  const guideRows =
    LIST_GUIDE_MARGIN_ROWS +
    discoverInputGuideLines(contentWidth, state.discover.marked.size > 0).length;
  const budgetRows = Math.min(
    Math.max(1, bodyRows - guideRows + 1),
    BROWSE_VISIBLE_COUNT * DISCOVER_ITEM_ROWS + 2,
  );
  const window = computeRowBudgetWindow({
    cursor,
    itemRows: Array.from({ length: total }, () => DISCOVER_ITEM_ROWS),
    budgetRows,
    previousStart: state.nav.discoverStart,
  });
  return panelListSlice({ window, cursor, total });
}

function installedListSlice(input: ListWindowInput & { pendingReload: boolean }): PanelListWindow {
  const { state, pluginErrorCount, total, cursor, viewport, pendingReload } = input;
  const contentWidth = Math.max(1, viewport.width - CONTENT_PAD * 2);
  const bodyRows = frameBodyRows(
    {
      state,
      pluginErrorCount,
      maxRows: viewport.terminalRows,
      body: [],
    },
    viewport.width,
  );
  const reloadRows = pendingReload ? 2 : 0;
  const guideRows =
    LIST_GUIDE_MARGIN_ROWS + installedInputGuideLines(contentWidth).length + reloadRows;
  const budgetRows = Math.max(1, bodyRows - guideRows);
  if (budgetRows >= INSTALLED_VISIBLE_COUNT + 2) {
    return computeItemCountWindow({
      cursor,
      total,
      visibleCount: INSTALLED_VISIBLE_COUNT,
      previousStart: state.nav.installedStart,
    });
  }
  const window = computeRowBudgetWindow({
    cursor,
    itemRows: Array.from({ length: total }, () => 1),
    budgetRows,
    previousStart: state.nav.installedStart,
  });
  return panelListSlice({ window, cursor, total });
}

function marketplaceListSlice(input: ListWindowInput): PanelListWindow {
  const { state, pluginErrorCount, cursor, viewport } = input;
  const marketplaceCount = input.total;
  const total = marketplaceCount + 1;
  const bodyRows = frameBodyRows(
    {
      state,
      pluginErrorCount,
      maxRows: viewport.terminalRows,
      body: [],
    },
    viewport.width,
  );
  const budgetRows = Math.min(bodyRows, BROWSE_VISIBLE_COUNT * MARKETPLACE_ITEM_ROWS + 2);
  const window = computeRowBudgetWindow({
    cursor,
    itemRows: [
      MARKETPLACE_ACTION_ROWS,
      ...Array.from({ length: marketplaceCount }, () => MARKETPLACE_ITEM_ROWS),
    ],
    budgetRows,
    previousStart: state.nav.marketplacesStart,
  });
  return panelListSlice({ window, cursor, total });
}

export type PanelModel = ReturnType<typeof buildPanelModel>["model"];

/**
 * One read of the engine registries projected through the panel state. Window
 * bookkeeping comes back as a nav patch instead of being written in place, and
 * list rows are charged against the shared frame budget for the current viewport.
 */
export function buildPanelModel(
  state: PanelState,
  viewport: PanelViewport,
): { model: PanelModelShape; next: PanelState } {
  const installed = installedPlugins(state);
  const marketplaces = listAvailableMarketplaces();
  const installedIdentities = new Set(installed.map((plugin) => favoriteIdentity(plugin)));
  const discover: DiscoverItem[] = [];
  for (const mp of marketplaces) {
    for (const entry of listMarketplacePlugins(mp.name)) {
      const installedHere = installedIdentities.has(createPluginId(entry.name, mp.name));
      discover.push({ marketplace: mp.name, entry, installed: installedHere });
    }
  }
  discover.sort((a, b) => {
    const countA = a.entry.installCount ?? 0;
    const countB = b.entry.installCount ?? 0;
    if (countA !== countB) return countB - countA;
    return a.entry.name.localeCompare(b.entry.name);
  });
  // Discover proposes: it only lists what is not installed yet. A marketplace
  // browse catalogues: it lists everything that marketplace carries, installed
  // rows included, so a marketplace whose plugins are all here still has a list.
  const browseScope = state.discover.marketplaceFilter;
  const discoverScoped =
    browseScope === null
      ? discover.filter((item) => !item.installed)
      : discover.filter((item) => item.marketplace === browseScope);

  const qlower = state.search.query.trim().toLowerCase();
  const discoverFiltered =
    qlower === ""
      ? discoverScoped
      : discoverScoped.filter(
          (d) =>
            d.entry.name.toLowerCase().includes(qlower) ||
            (d.entry.description ?? "").toLowerCase().includes(qlower) ||
            d.marketplace.toLowerCase().includes(qlower),
        );

  const pluginErrors = getSnapshot().errors;
  const installedItems = buildInstalledItems(state, installed, pluginErrors);
  const disusedDays = new Map<string, number>();
  for (const item of installedItems) {
    if (item.type !== "plugin" || !item.isEnabled) continue;
    if (isPluginDisused(item.id)) {
      disusedDays.set(item.id, pluginDisuse(item.id)!.daysSinceLastUse);
    }
  }
  const filteredInstalledItems = filterInstalledItems(installedItems, state.search.query);
  const installedRows = qlower
    ? filteredInstalledItems.map((item) => ({
        kind: "item" as const,
        id: `main:${item.id}`,
        section: "main" as const,
        item,
      }))
    : buildInstalledRows(installedItems, {
        favoriteIds: state.data.favorites,
        disusedDays,
        showDisabled: state.installed.showDisabled,
        keepInPlaceIds: state.installed.keepInPlaceIds,
      });

  const pluginErrorCount = pluginErrors.length;
  const pendingReload = getSnapshot().needsRefresh;
  const tab = state.nav.tab;
  const count =
    tab === "installed"
      ? installedRows.length
      : tab === "marketplaces"
        ? marketplaces.length + 1
        : discoverFiltered.length;
  const selectedIndex = clampIndex(state.nav.selected, count);
  const selectedMarketplace =
    tab === "marketplaces" && selectedIndex > 0 ? marketplaces[selectedIndex - 1] : undefined;
  const marketplaceInstalledPlugins = selectedMarketplace
    ? installed
        .filter(
          (plugin) =>
            (findPluginInstallation(favoriteIdentity(plugin))?.marketplace ?? plugin.source) ===
            selectedMarketplace.name,
        )
        .map((plugin) => ({
          name: plugin.manifest.name,
          ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
        }))
    : [];

  const discoverListVisible = tab === "discover" && state.discover.details === null;
  const installedListVisible = tab === "installed" && state.installed.detail.kind === "list";
  const listVisible =
    discoverListVisible ||
    installedListVisible ||
    (tab === "marketplaces" && state.marketplaces.view === "list");

  const browseWindow =
    tab === "marketplaces"
      ? marketplaceListSlice({
          state,
          pluginErrorCount,
          total: marketplaces.length,
          cursor: selectedIndex,
          viewport,
        })
      : discoverListSlice({
          state,
          pluginErrorCount,
          total: discoverFiltered.length,
          cursor: selectedIndex,
          viewport,
        });

  // Open on the leading header rows while the cursor sits on the first
  // selectable row, so the section context above it stays visible.
  const firstSelectableRow = Math.max(0, installedRows.findIndex(isSelectableInstalledRow));
  const installedWindowState =
    selectedIndex <= firstSelectableRow ? withNav(state, { installedStart: 0 }) : state;
  const installedListWindow = installedListSlice({
    state: installedWindowState,
    pluginErrorCount,
    total: installedRows.length,
    cursor: selectedIndex,
    pendingReload,
    viewport,
  });

  let next = state;
  if (discoverListVisible) next = withNav(next, { discoverStart: browseWindow.from });
  else if (tab === "marketplaces") next = withNav(next, { marketplacesStart: browseWindow.from });
  if (installedListVisible) next = withNav(next, { installedStart: installedListWindow.from });

  const model = {
    installed,
    marketplaces,
    discoverFiltered,
    installedRows,
    installedItems,
    pluginErrors,
    pluginErrorCount,
    pendingReload,
    count,
    selectedIndex,
    selectedMarketplace,
    marketplaceInstalledPlugins,
    discoverListVisible,
    installedListVisible,
    listVisible,
    browseWindow,
    installedWindow: installedListWindow,
    qlower,
  };
  return { model, next };
}

type PanelModelShape = {
  installed: LoadedPlugin[];
  marketplaces: ReturnType<typeof listAvailableMarketplaces>;
  discoverFiltered: DiscoverItem[];
  installedRows: ReturnType<typeof buildInstalledRows>;
  installedItems: InstalledItem[];
  pluginErrors: ReturnType<typeof getSnapshot>["errors"];
  pluginErrorCount: number;
  pendingReload: boolean;
  count: number;
  selectedIndex: number;
  selectedMarketplace: ReturnType<typeof listAvailableMarketplaces>[number] | undefined;
  marketplaceInstalledPlugins: { name: string; description?: string }[];
  discoverListVisible: boolean;
  installedListVisible: boolean;
  listVisible: boolean;
  browseWindow: ReturnType<typeof computeItemCountWindow>;
  installedWindow: ReturnType<typeof computeItemCountWindow>;
  qlower: string;
};

function installedPlugins(state: PanelState): LoadedPlugin[] {
  const activeEntries = plugins.list();
  const activeIds = new Set(activeEntries.map((entry) => entry.pluginId));
  const pendingInstalls = listPluginInstallations()
    .filter((installation) => !activeIds.has(installation.identity))
    .map((installation) => loadPluginFromDirectory(installation.installPath, installation.identity))
    .filter((plugin): plugin is LoadedPlugin => plugin !== null);
  return [...activeEntries.map((entry) => entry.plugin), ...pendingInstalls]
    .filter((plugin) => !state.data.uninstalled.has(favoriteIdentity(plugin)))
    .sort((a, b) => {
      const scopeDelta =
        installScopeRank(findPluginInstallation(favoriteIdentity(a))?.scope) -
        installScopeRank(findPluginInstallation(favoriteIdentity(b))?.scope);
      if (scopeDelta !== 0) return scopeDelta;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
}

function buildInstalledItems(
  state: PanelState,
  installed: readonly LoadedPlugin[],
  pluginErrors: ReturnType<typeof getSnapshot>["errors"],
): InstalledItem[] {
  const runtimeEnabled = new Set(
    plugins
      .list()
      .filter((entry) => plugins.isRuntimeEnabled(entry.pluginId))
      .map((entry) => entry.pluginId),
  );
  const items: InstalledItem[] = [];
  for (const plugin of installed) {
    const identity = favoriteIdentity(plugin);
    const installation = findPluginInstallation(identity);
    const totalCount = pluginUseCount(identity);
    const skillCount =
      totalCount === 0
        ? 0
        : listSkills().filter(
            (skill) =>
              skill.source === "plugin" &&
              skill.name.startsWith(`${identity}:`) &&
              (skillUseFor(skill.name)?.count ?? 0) > 0,
          ).length;
    items.push({
      type: "plugin",
      id: identity,
      plugin,
      name: plugin.manifest.name,
      marketplace: installation?.marketplace ?? plugin.source,
      scope: installation?.scope ?? "user",
      isEnabled: plugins.isEnabledSetting(identity),
      appliedEnabled: runtimeEnabled.has(identity),
      errorCount: pluginErrors.filter((error) => error.pluginId === identity).length,
      ...(totalCount > 0 ? { activity: { skillCount, totalCount } } : {}),
    });
  }
  const matched = new Set(installed.map((plugin) => favoriteIdentity(plugin)));
  const orphanGroups = new Map<string, typeof pluginErrors>();
  for (const error of pluginErrors) {
    const pid = error.pluginId ?? "unknown";
    if (matched.has(pid)) continue;
    orphanGroups.set(pid, [...(orphanGroups.get(pid) ?? []), error]);
  }
  for (const [pid, errs] of orphanGroups) {
    const at = pid.indexOf("@");
    items.push({
      type: "failed-plugin",
      id: pid,
      name: at > 0 ? pid.slice(0, at) : pid,
      marketplace: at > 0 ? pid.slice(at + 1) : "unknown",
      scope: "user",
      errorCount: errs.length,
    });
  }
  const pluginServers = gatherPluginMcpServers();
  const pluginStatuses = mcpServerStatuses(Object.keys(pluginServers));
  for (const plugin of installed) {
    const identity = favoriteIdentity(plugin);
    const scope = findPluginInstallation(identity)?.scope ?? "user";
    for (const serverName of Object.keys(pluginServers)) {
      if (!serverName.startsWith(`plugin:${identity}:`)) continue;
      const enabled = !state.data.disabledMcpNames.has(serverName);
      const status = enabled
        ? (pluginStatuses.find((s) => s.name === serverName)?.status ?? "pending")
        : "disabled";
      items.push({
        type: "mcp",
        id: `mcp:${serverName}`,
        name: serverName.slice(`plugin:${identity}:`.length),
        scope,
        status,
        indented: true,
        parentId: identity,
      });
    }
  }
  items.push(...state.data.standaloneMcp);
  // Installed lists what the user put there: plugin skills ride their plugin
  // row, and built-ins are product furniture — only user/project skills appear.
  for (const skill of listSkills()) {
    if (skill.source === "plugin" || skill.builtin) continue;
    const usage = skillUseFor(skill.name);
    items.push({
      type: "skill",
      id: `skill:${skill.name}`,
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      ...(skill.skillRoot ? { skillRoot: skill.skillRoot } : {}),
      scope: "skills",
      sourceLabel: skillSourceLabel(skill.source),
      state: skillStateFor(skill),
      authorLocked: skill.authorModelLock,
      tokenEstimate: skillTokenEstimate(skill),
      ...(usage ? { usage } : {}),
    });
  }
  return sortInstalledItems(items);
}

/** Keeps the cursor on a selectable row; the installed list carries headers. */
export function clampedSelection(state: PanelState, model: PanelModelShape): PanelState {
  let selected = clampIndex(state.nav.selected, model.count);
  if (state.nav.tab === "installed") {
    const row = model.installedRows[selected];
    if (!row || !isSelectableInstalledRow(row)) {
      const forward = findSelectableInstalledRow(model.installedRows, selected, 1);
      const backward = findSelectableInstalledRow(model.installedRows, selected, -1);
      selected = forward >= 0 ? forward : backward >= 0 ? backward : 0;
    }
  }
  return selected === state.nav.selected ? state : withNav(state, { selected });
}
