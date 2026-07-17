import { useEffect, useRef, useState } from "react";
import { publish } from "@/engine/background/tasks/bus.ts";
import {
  changeEnabledWithDependencies,
  registryDependencyPlugins,
  requiredByWarning,
  reverseDependents,
} from "@/engine/plugins/dependencies.ts";
import { createPluginId } from "@/engine/plugins/identity.ts";
import { removePlugin } from "@/engine/plugins/install.ts";
import {
  findPluginInstallation,
  listPluginInstallations,
  type PluginInstallScope,
} from "@/engine/plugins/installations.ts";
import { type LoadedPlugin, loadPluginFromDirectory } from "@/engine/plugins/loader.ts";
import {
  addMarketplace,
  installMarketplacePlugin,
  listMarketplacePlugins,
  refreshOfficialCatalog,
  updateMarketplacePlugin,
} from "@/engine/plugins/marketplace.ts";
import {
  listAvailableMarketplaces,
  removeKnownMarketplace,
} from "@/engine/plugins/marketplaces-store.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { getSnapshot } from "@/engine/plugins/state.ts";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { mcpServerStatuses } from "@/kernel/mcp/client/registry.ts";
import { startOAuthFlow } from "@/kernel/mcp/oauth/flow.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOptionalOverlayDispatch } from "@/ui/panels/context/index.tsx";
import { consumePendingPluginCommandResult } from "@/ui/panels/plugins/command-result.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import {
  DISCOVER_INPUT_GUIDE,
  footerHintsFor,
  INSTALLED_DETAILS_HINTS,
  type PanelSubtitleParts,
  subtitleFor,
  tabLabelFor,
} from "./chrome.ts";
import {
  clampPluginsIndex,
  DISCOVER_MAX_VISIBLE,
  discoverPageWindow,
  type PluginsPageRow,
  pagePluginsIndex,
  pluginsFooterRows,
  pluginsPageRows,
  pluginsPageWindow,
  selectedInstalledPlugin,
} from "./pagination.ts";
import {
  type DiscoverItem,
  type MarketplaceView,
  type PluginsOverlayProps,
  TABS,
  type Tab,
} from "./types.ts";
import {
  DiscoverDetailsView,
  DiscoverView,
  ErrorsView,
  INSTALL_SCOPES,
  type InstalledDetailsAction,
  InstalledDetailsView,
  InstalledView,
  MarketplacesView,
} from "./views.tsx";

export type { PluginsOverlayProps } from "./types.ts";

function loadFavoriteNames(): ReadonlySet<string> {
  const favorites = loadConfigSync().pluginFavorites;
  if (!Array.isArray(favorites)) return new Set();
  return new Set(
    favorites.filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function persistFavorites(next: ReadonlySet<string>): void {
  void updateConfig((cfg) => {
    cfg.pluginFavorites = [...next].sort((a, b) => a.localeCompare(b));
  });
}

function favoriteIdentity(plugin: LoadedPlugin): string {
  return plugins.pluginIdForPlugin(plugin);
}

const INSTALL_SCOPE_RANK: Record<PluginInstallScope, number> = { project: 0, local: 1, user: 2 };

function installScopeRank(scope: PluginInstallScope | undefined): number {
  return INSTALL_SCOPE_RANK[scope ?? "user"];
}

function installScopeHeading(scope: PluginInstallScope | undefined): string {
  const resolved = scope ?? "user";
  if (resolved === "project") return "Project";
  if (resolved === "local") return "Local";
  return "User";
}

function withReloadHint(message: string, ok: boolean): string {
  if (!ok || message.includes("/reload")) return message;
  const separator = message.endsWith(".") || message.endsWith("!") ? " " : ". ";
  return `${message}${separator}Run /reload to apply.`;
}

export function PluginsOverlay({
  onClose,
  commandResult: commandResultProp,
}: PluginsOverlayProps = {}): React.JSX.Element {
  const { columns, rows: terminalRows } = useTerminalDimensions();
  const overlayDispatch = useOptionalOverlayDispatch();
  const close = useOverlayClose(onClose);
  const [tab, setTab] = useState<Tab>("discover");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [addInput, setAddInput] = useState<string | null>(null);
  const [marketplaceView, setMarketplaceView] = useState<MarketplaceView>("list");
  const [detailsSelection, setDetailsSelection] = useState(0);
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [discoverDetails, setDiscoverDetails] = useState<DiscoverItem | null>(null);
  const [installScope, setInstallScope] = useState<PluginInstallScope>("user");
  const [installedDetails, setInstalledDetails] = useState<LoadedPlugin | null>(null);
  const [installedActionIndex, setInstalledActionIndex] = useState(0);
  const [installedNotice, setInstalledNotice] = useState<string | null>(null);
  const authAbortRef = useRef<AbortController | null>(null);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => loadFavoriteNames());
  const [commandResult] = useState<string | null>(
    () => commandResultProp ?? consumePendingPluginCommandResult(),
  );
  const [catalogTick, setCatalogTick] = useState(0);
  const [uninstalled, setUninstalled] = useState<ReadonlySet<string>>(() => new Set());
  const discoverStartRef = useRef(0);

  // Installed rows cover the active registry plus disk installations that are
  // still pending a /reload (fresh installs), minus plugins
  // uninstalled from this panel (their loaded copy stays active until reload,
  // but the list drops them immediately). Rows group by installation scope
  // (project → local → user, the scope-precedence order) and sort by name
  // within each group.
  const activeEntries = plugins.list();
  const activeIds = new Set(activeEntries.map((entry) => entry.pluginId));
  const runtimeEnabled = new Set(
    activeEntries
      .filter((entry) => plugins.isRuntimeEnabled(entry.pluginId))
      .map((entry) => entry.pluginId),
  );
  const pendingInstalls = listPluginInstallations()
    .filter((installation) => !activeIds.has(installation.identity))
    .map((installation) => loadPluginFromDirectory(installation.installPath, installation.identity))
    .filter((plugin): plugin is LoadedPlugin => plugin !== null);
  const installed = [...activeEntries.map((entry) => entry.plugin), ...pendingInstalls]
    .filter((plugin) => !uninstalled.has(favoriteIdentity(plugin)))
    .sort((a, b) => {
      const scopeDelta =
        installScopeRank(findPluginInstallation(favoriteIdentity(a))?.scope) -
        installScopeRank(findPluginInstallation(favoriteIdentity(b))?.scope);
      if (scopeDelta !== 0) return scopeDelta;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  const favoriteIdentities = new Set(
    installed
      .filter((plugin) => favorites.has(favoriteIdentity(plugin)))
      .map((plugin) => favoriteIdentity(plugin)),
  );
  const marketplaces = listAvailableMarketplaces();
  // Discover entries come from marketplace checkouts (official fixed-pointer
  // clone bootstrapped on demand). The plugin-stats catalog only overlays
  // install counts.
  // Installed plugins are excluded, and entries rank by install count
  // (descending) with an alphabetical tiebreak.
  const installedIdentities = new Set(installed.map((plugin) => favoriteIdentity(plugin)));
  const discover: DiscoverItem[] = [];
  for (const mp of marketplaces) {
    for (const entry of listMarketplacePlugins(mp.name)) {
      if (installedIdentities.has(createPluginId(entry.name, mp.name))) continue;
      discover.push({ marketplace: mp.name, entry });
    }
  }
  discover.sort((a, b) => {
    const countA = a.entry.installCount ?? 0;
    const countB = b.entry.installCount ?? 0;
    if (countA !== countB) return countB - countA;
    return a.entry.name.localeCompare(b.entry.name);
  });
  // catalogTick forces re-read after a successful background counts refresh.
  void catalogTick;

  const qlower = query.trim().toLowerCase();
  const discoverFiltered =
    qlower === ""
      ? discover
      : discover.filter(
          (d) =>
            d.entry.name.toLowerCase().includes(qlower) ||
            (d.entry.description ?? "").toLowerCase().includes(qlower) ||
            d.marketplace.toLowerCase().includes(qlower),
        );

  // Installed search filters plugin rows and plugin-MCP rows alike.
  const installedFiltered =
    qlower === ""
      ? installed
      : installed.filter(
          (plugin) =>
            favoriteIdentity(plugin).toLowerCase().includes(qlower) ||
            (plugin.manifest.description ?? "").toLowerCase().includes(qlower),
        );
  const installedMcpNames = tab === "installed" ? Object.keys(gatherPluginMcpServers()) : [];
  const installedMcpNamesFiltered =
    qlower === ""
      ? installedMcpNames
      : installedMcpNames.filter((name) => name.toLowerCase().includes(qlower));
  const installedMcpCount = installedMcpNamesFiltered.length;
  const pluginErrorCount = getSnapshot().errors.length;
  const pendingReload = getSnapshot().needsRefresh;
  const count =
    tab === "installed"
      ? installedFiltered.length + installedMcpCount
      : tab === "marketplaces"
        ? marketplaces.length + 1
        : discoverFiltered.length;
  const selectedIndex = clampPluginsIndex(selected, count);
  const selectedMarketplace =
    tab === "marketplaces" && selectedIndex > 0 ? marketplaces[selectedIndex - 1] : undefined;
  const discoverListVisible = tab === "discover" && discoverDetails === null;
  const footerHints =
    discoverDetails !== null
      ? ([
          ["Enter", "select"],
          ["Esc", "back"],
        ] satisfies [string, string][])
      : tab === "installed" && installedDetails !== null
        ? INSTALLED_DETAILS_HINTS
        : footerHintsFor(tab, marketplaceView);
  const inputGuide = discoverListVisible ? DISCOVER_INPUT_GUIDE : undefined;
  const listVisible =
    discoverListVisible ||
    (tab === "installed" && installedDetails === null) ||
    (tab === "marketplaces" && marketplaceView === "list");
  const listRows = listVisible
    ? pluginsPageRows(terminalRows, {
        searchVisible: tab === "discover" || tab === "installed",
        commandResult: commandResult !== null,
        busy: busy !== null,
        footerRows: pluginsFooterRows(columns, footerHints),
      })
    : 1;
  const pageRows = buildPluginsPageRows({
    tab,
    installed: installedFiltered,
    mcpNames: installedMcpNamesFiltered,
    marketplaces,
    discover: discoverFiltered,
  });
  const pageWindow = discoverListVisible
    ? discoverPageWindow(pageRows, selectedIndex, discoverStartRef.current, DISCOVER_MAX_VISIBLE)
    : pluginsPageWindow(pageRows, selectedIndex, listRows);

  useEffect(() => {
    setSelected(0);
    setQuery("");
    setSearchFocused(false);
    setMarketplaceView("list");
    setDetailsSelection(0);
    setDiscoverDetails(null);
    setInstallScope("user");
    setInstalledDetails(null);
    setInstalledActionIndex(0);
    setInstalledNotice(null);
    discoverStartRef.current = 0;
  }, [tab]);

  useEffect(() => {
    setSelected((idx) => clampPluginsIndex(idx, count));
  }, [count, listRows]);

  useEffect(() => {
    if (discoverListVisible) discoverStartRef.current = pageWindow.firstItem;
  }, [discoverListVisible, pageWindow.firstItem]);

  useEffect(() => {
    if (tab !== "discover" && tab !== "installed") return;
    discoverStartRef.current = 0;
    setSelected(0);
  }, [query, tab]);

  // Best-effort install-counts refresh (24h TTL catalog cache).
  // Discover entries remain sourced exclusively from marketplace checkouts.
  useEffect(() => {
    let cancelled = false;
    void refreshOfficialCatalog().then((catalog) => {
      if (!cancelled && catalog) setCatalogTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleInstalled(pluginId: string): Promise<void> {
    const next = !plugins.isEnabledSetting(pluginId);
    setBusy(`${next ? "Enabling" : "Disabling"} ${pluginId}`);
    const result = await changeEnabledWithDependencies(pluginId, next);
    setBusy(null);
    if (!result.success) publish("error", result.message);
  }

  function installedDetailActions(plugin: LoadedPlugin): InstalledDetailsAction[] {
    const pluginId = plugins.pluginIdForPlugin(plugin);
    const enabled = plugins.isEnabledSetting(pluginId);
    const installation = findPluginInstallation(pluginId);
    const actions: InstalledDetailsAction[] = [
      { id: "toggle", label: enabled ? "Disable plugin" : "Enable plugin" },
      {
        id: "favorite",
        label: favorites.has(pluginId) ? "Remove from favorites" : "Add to favorites",
      },
    ];
    if (installation) {
      actions.push({ id: "mark-update", label: "Mark for update" });
      actions.push({ id: "update", label: "Update now" });
      actions.push({ id: "uninstall", label: "Uninstall" });
    }
    if (plugin.manifest.homepage) actions.push({ id: "homepage", label: "Open homepage" });
    if (plugin.manifest.repository) actions.push({ id: "repository", label: "View repository" });
    actions.push({ id: "back", label: "Back to plugin list" });
    return actions;
  }

  async function runInstalledDetailAction(plugin: LoadedPlugin, actionId: string): Promise<void> {
    const pluginId = plugins.pluginIdForPlugin(plugin);
    if (actionId === "back") {
      setInstalledDetails(null);
      setInstalledActionIndex(0);
      setInstalledNotice(null);
      return;
    }
    if (actionId === "favorite") {
      toggleFavorite(plugin);
      return;
    }
    if (actionId === "homepage" && plugin.manifest.homepage) {
      void openBrowser(plugin.manifest.homepage);
      return;
    }
    if (actionId === "repository" && plugin.manifest.repository) {
      void openBrowser(plugin.manifest.repository);
      return;
    }
    if (actionId === "toggle") {
      await toggleInstalled(pluginId);
      return;
    }
    if (actionId === "mark-update") {
      const installation = findPluginInstallation(pluginId);
      const marketplace = marketplaces.find(
        (candidate) => candidate.name === installation?.marketplace,
      );
      if (marketplace?.sourceType === "file") {
        setInstalledNotice(
          `Local plugins cannot be updated remotely. To update, modify the source at: ./plugins/${plugin.manifest.name}`,
        );
      }
      return;
    }
    if (actionId === "update") {
      const installation = findPluginInstallation(pluginId);
      setBusy(`Updating ${pluginId}`);
      const res = updateMarketplacePlugin(pluginId, undefined, installation?.installationId);
      setBusy(null);
      publish(res.success ? "success" : "error", withReloadHint(res.message, res.success));
      return;
    }
    if (actionId === "uninstall") {
      setBusy(`Uninstalling ${pluginId}`);
      const dependents = reverseDependents(pluginId, registryDependencyPlugins());
      const res = await removePlugin(pluginId);
      setBusy(null);
      publish(
        res.success ? "success" : "error",
        withReloadHint(
          `${res.message}${res.success ? requiredByWarning(dependents) : ""}`,
          res.success,
        ),
      );
      if (res.success) {
        setUninstalled((previous) => new Set(previous).add(pluginId));
        setInstalledDetails(null);
        setInstalledActionIndex(0);
        setInstalledNotice(null);
        setSelected(0);
      }
    }
  }

  function toggleFavorite(plugin: LoadedPlugin): void {
    setFavorites((previous) => {
      const identity = favoriteIdentity(plugin);
      const next = new Set(previous);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      persistFavorites(next);
      return next;
    });
  }

  async function authenticatePluginMcp(serverName: string): Promise<void> {
    const config = gatherPluginMcpServers()[serverName];
    if (!config || (config.type !== "http" && config.type !== "sse")) {
      publish("error", `MCP "${serverName}" does not support browser authentication.`);
      return;
    }
    const controller = new AbortController();
    authAbortRef.current = controller;
    setBusy(`Authorizing ${serverName} — complete in your browser (Esc to cancel)`);
    try {
      const flow = await startOAuthFlow({
        serverName,
        baseUrl: config.url,
        abortSignal: controller.signal,
        ...(config.oauthScopes ? { scope: config.oauthScopes } : {}),
      });
      const outcome = await flow.done;
      if (outcome.kind === "saved") {
        publish("success", `MCP "${serverName}" authorized`);
        setCatalogTick((n) => n + 1);
      } else {
        publish("error", `MCP "${serverName}" auth failed: ${outcome.reason}`);
      }
    } catch (e) {
      publish(
        "error",
        `MCP "${serverName}" auth error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      authAbortRef.current = null;
      setBusy(null);
    }
  }

  async function installBatch(
    items: DiscoverItem[],
    scope: PluginInstallScope = "user",
  ): Promise<void> {
    if (items.length === 0) return;
    setBusy(`Installing ${items.length} plugin${items.length === 1 ? "" : "s"}`);
    const results = items.map((item) =>
      installMarketplacePlugin(item.marketplace, item.entry.name, scope),
    );
    const installed = results.filter((result) => result.success);
    setBusy(null);
    setMarked(new Set());
    setDiscoverDetails(null);
    if (installed.length === 1) {
      const feedback = "✓ Installed 1 plugin. Run /reload to activate.";
      overlayDispatch?.recordPanelCommit?.("plugins", feedback);
      if (!overlayDispatch) publish("success", feedback);
      close();
    } else if (installed.length > 1) {
      const feedback = `✓ Installed ${installed.length} plugins. Run /reload to activate.`;
      overlayDispatch?.recordPanelCommit?.("plugins", feedback);
      if (!overlayDispatch) publish("success", feedback);
      close();
    } else {
      publish("error", results[0]?.message ?? "No plugins installed.");
    }
  }

  function submitAddMarketplace(): void {
    const source = (addInput ?? "").trim();
    if (source.length === 0) return;
    setBusy("Adding marketplace");
    const res = addMarketplace(source);
    setBusy(null);
    setAddInput(null);
    if (res.ok) {
      publish("success", `Added marketplace ${res.name} (${res.count} plugins)`);
    } else {
      publish("error", res.error ?? "failed to add marketplace");
    }
  }

  function updateMarketplace(source: string): void {
    setBusy("Updating marketplace");
    const res = addMarketplace(source);
    setBusy(null);
    if (res.ok) {
      publish("success", `Updated marketplace ${res.name} (${res.count} plugins)`);
      return;
    }
    publish("error", res.error ?? "failed to update marketplace");
  }

  function removeMarketplace(name: string): void {
    const removed = removeKnownMarketplace(name);
    if (removed) {
      publish("success", `Removed marketplace ${name}`);
      setMarketplaceView("list");
      setSelected((idx) => Math.max(0, idx - 1));
      return;
    }
    publish("error", `Marketplace not found: ${name}`);
  }

  function cancelPanel(): void {
    if (tab === "discover" && discoverDetails) {
      setDiscoverDetails(null);
      setInstallScope("user");
      return;
    }
    if (tab === "installed" && installedDetails) {
      setInstalledDetails(null);
      setInstalledActionIndex(0);
      setInstalledNotice(null);
      return;
    }
    // Search-mode Esc layering: a first press clears the query, a second
    // leaves search mode; list mode closes the panel directly.
    if ((tab === "discover" || tab === "installed") && searchFocused) {
      if (query.length > 0) setQuery("");
      else setSearchFocused(false);
      return;
    }
    if (tab === "marketplaces" && marketplaceView !== "list") {
      setMarketplaceView("list");
      setDetailsSelection(0);
      return;
    }
    close();
  }

  usePanelNavigation({
    onClose: cancelPanel,
    skipEsc: true,
    onKey: (input, key) => {
      if (busy && authAbortRef.current) {
        if (key.escape) {
          authAbortRef.current.abort();
          return true;
        }
        return false;
      }
      if (busy) return false;
      if (addInput !== null) {
        if (key.return) {
          submitAddMarketplace();
          return true;
        }
        if (key.leftArrow || key.escape) {
          setAddInput(null);
          return true;
        }
        if (key.backspace || key.delete) {
          setAddInput((v) => (v ?? "").slice(0, -1));
          return true;
        }
        if (input && !key.ctrl && !key.meta) {
          setAddInput((v) => (v ?? "") + input);
          return true;
        }
        return false;
      }
      if (key.escape) {
        cancelPanel();
        return true;
      }
      if (tab === "discover" && discoverDetails) {
        const currentScope = INSTALL_SCOPES.indexOf(installScope);
        if (key.upArrow) {
          setInstallScope(
            INSTALL_SCOPES[(currentScope + INSTALL_SCOPES.length - 1) % INSTALL_SCOPES.length]!,
          );
          return true;
        }
        if (key.downArrow) {
          setInstallScope(INSTALL_SCOPES[(currentScope + 1) % INSTALL_SCOPES.length]!);
          return true;
        }
        if (key.return) {
          void installBatch([discoverDetails], installScope);
          return true;
        }
        return false;
      }
      if (tab === "installed" && installedDetails) {
        const actions = installedDetailActions(installedDetails);
        if (key.upArrow) {
          setInstalledActionIndex(
            (index) => (index + actions.length - 1) % Math.max(1, actions.length),
          );
          return true;
        }
        if (key.downArrow) {
          setInstalledActionIndex((index) => (index + 1) % Math.max(1, actions.length));
          return true;
        }
        if (key.return) {
          const action = actions[Math.min(installedActionIndex, actions.length - 1)];
          if (action) void runInstalledDetailAction(installedDetails, action.id);
          return true;
        }
        return false;
      }
      // Search mode owns every key: printable input (spaces included) edits
      // the query, Enter commits, Down drops to the list, and backspace on an
      // empty query leaves search mode. Tab switching stays out of reach so a
      // typed query is never torn away mid-edit.
      if ((tab === "discover" || tab === "installed") && searchFocused) {
        if (key.backspace || key.delete) {
          if (query.length > 1) setQuery((v) => v.slice(0, -1));
          else {
            setQuery("");
            setSearchFocused(false);
          }
          return true;
        }
        if (key.return || key.downArrow) {
          setSearchFocused(false);
          return true;
        }
        if (
          key.upArrow ||
          key.leftArrow ||
          key.rightArrow ||
          key.pageUp ||
          key.pageDown ||
          key.tab
        ) {
          return true;
        }
        if (input && !key.ctrl && !key.meta) {
          setQuery((v) => v + input);
          return true;
        }
        return false;
      }
      if (key.leftArrow) {
        setTab((t) => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length]!);
        return true;
      }
      if (key.rightArrow) {
        setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length]!);
        return true;
      }
      if (tab === "marketplaces" && marketplaceView !== "list") {
        if (marketplaceView === "confirm-remove") {
          if ((input === "y" || input === "Y") && selectedMarketplace) {
            removeMarketplace(selectedMarketplace.name);
            return true;
          }
          if (input === "n" || input === "N") {
            setMarketplaceView("list");
            return true;
          }
          return false;
        }
        if (key.upArrow || key.downArrow) {
          setDetailsSelection((idx) => (idx === 0 ? 1 : 0));
          return true;
        }
        if (selectedMarketplace && (input === "u" || input === "U")) {
          updateMarketplace(selectedMarketplace.source);
          return true;
        }
        if (
          selectedMarketplace &&
          (input === "d" || input === "D" || input === "r" || input === "R")
        ) {
          setMarketplaceView("confirm-remove");
          return true;
        }
        if (key.return && selectedMarketplace) {
          if (detailsSelection === 0) {
            updateMarketplace(selectedMarketplace.source);
            return true;
          }
          setMarketplaceView("confirm-remove");
          return true;
        }
        return false;
      }
      if (key.pageUp && listVisible) {
        setSelected((idx) => pagePluginsIndex(idx, count, -1, pageWindow.itemCapacity));
        return true;
      }
      if (key.pageDown && listVisible) {
        setSelected((idx) => pagePluginsIndex(idx, count, 1, pageWindow.itemCapacity));
        return true;
      }
      if (key.upArrow) {
        // Up from the first row hands focus back to the search field.
        if ((tab === "discover" || tab === "installed") && selectedIndex === 0) {
          setSearchFocused(true);
          return true;
        }
        setSelected((idx) => clampPluginsIndex(idx - 1, count));
        return true;
      }
      if (key.downArrow) {
        setSelected((idx) => clampPluginsIndex(idx + 1, count));
        return true;
      }
      if (tab === "marketplaces") {
        if (input === "a" || (key.return && selectedIndex === 0)) {
          setAddInput("");
          return true;
        }
        if (!selectedMarketplace) return false;
        if (input === "u" || input === "U") {
          updateMarketplace(selectedMarketplace.source);
          return true;
        }
        if (input === "d" || input === "D" || input === "r" || input === "R") {
          setMarketplaceView("confirm-remove");
          return true;
        }
        if (key.return) {
          setMarketplaceView("details");
          setDetailsSelection(0);
          return true;
        }
        return false;
      }
      if (tab === "installed") {
        if (input === "j" || input === "k") {
          setSelected((idx) => clampPluginsIndex(idx + (input === "j" ? 1 : -1), count));
          return true;
        }
        const target = selectedInstalledPlugin(installedFiltered, selectedIndex);
        if (target) {
          if (input === " ") {
            void toggleInstalled(plugins.pluginIdForPlugin(target));
            return true;
          }
          if (key.return) {
            setInstalledDetails(target);
            setInstalledActionIndex(0);
            setInstalledNotice(null);
            return true;
          }
          if (input === "f" || input === "F") {
            toggleFavorite(target);
            return true;
          }
        } else {
          const server = mcpServerStatuses([...installedMcpNamesFiltered])[
            selectedIndex - installedFiltered.length
          ];
          if (server && (key.return || input === " ") && server.status === "needs-auth") {
            void authenticatePluginMcp(server.name);
            return true;
          }
        }
        if (input === "/") {
          setSearchFocused(true);
          setQuery("");
          setSelected(0);
          return true;
        }
        // Any other printable character starts a search seeded with it.
        if (input && input.trim() !== "" && !key.return && !key.ctrl && !key.meta) {
          setSearchFocused(true);
          setQuery(input);
          setSelected(0);
          return true;
        }
        return false;
      }
      if (tab === "discover") {
        if (input === "j" || input === "k") {
          setSelected((idx) => clampPluginsIndex(idx + (input === "j" ? 1 : -1), count));
          return true;
        }
        const item = discoverFiltered[selectedIndex];
        if (item && input === " ") {
          const k = `${item.marketplace}:${item.entry.name}`;
          setMarked((prev) => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
          });
          return true;
        }
        if (input === "i" || input === "I") {
          const selectedItems =
            marked.size > 0
              ? discoverFiltered.filter((candidate) =>
                  marked.has(`${candidate.marketplace}:${candidate.entry.name}`),
                )
              : item === undefined
                ? []
                : [item];
          void installBatch(selectedItems);
          return true;
        }
        if (item && key.return) {
          setDiscoverDetails(item);
          setInstallScope("user");
          return true;
        }
        if (input === "/") {
          setSearchFocused(true);
          setQuery("");
          setSelected(0);
          return true;
        }
        // Any other printable character starts a search seeded with it.
        if (input && input.trim() !== "" && !key.return && !key.ctrl && !key.meta) {
          setSearchFocused(true);
          setQuery(input);
          setSelected(0);
          return true;
        }
        return false;
      }
      return false;
    },
  });

  if (addInput !== null) {
    return (
      <FooterPanel
        command="/plugins"
        flushTop
        onCancel={() => setAddInput(null)}
        disableCancelKey
        footerHints={[
          ["Enter", "add"],
          ["Esc", "cancel"],
        ]}
      >
        <Box flexDirection="column">
          <Text color={Color.textStrong} bold>
            Add marketplace
          </Text>
          <Text color={Color.muted}>git URL, github owner/repo, or local path</Text>
          <Box marginTop={1}>
            <Text color={Color.muted}>{Glyph.chevron}</Text>
            <Text color={Color.text}>{`${addInput}${Glyph.blockHalf}`}</Text>
          </Box>
        </Box>
      </FooterPanel>
    );
  }

  return (
    <FooterPanel
      command="/plugins"
      title="Plugins"
      tabs={TABS.map((t) => ({ label: tabLabelFor(t, pluginErrorCount) }))}
      activeTab={TABS.indexOf(tab)}
      subtitle={
        <PanelSubtitle
          parts={
            discoverDetails
              ? { heading: "Plugin details" }
              : installedDetails
                ? { heading: "" }
                : subtitleFor(tab, {
                    discover: discoverFiltered.length,
                    installed: installedFiltered.length,
                    marketplaces: marketplaces.length,
                    selected: selectedIndex,
                  })
          }
        />
      }
      tabsFocused
      search={
        (tab === "discover" && !discoverDetails) || (tab === "installed" && !installedDetails)
          ? { query, placeholder: "Search…", focused: searchFocused }
          : undefined
      }
      flushTop
      onCancel={cancelPanel}
      disableCancelKey
      footerHints={footerHints}
      {...(inputGuide !== undefined ? { inputGuide } : {})}
    >
      <Box flexDirection="column" marginTop={discoverListVisible ? 0 : 1}>
        {commandResult && (
          <Box marginBottom={1}>
            <Text color={Color.success}>
              {Glyph.check} {commandResult}
            </Text>
          </Box>
        )}
        {busy && (
          <Text color={Color.muted}>
            {Glyph.bullet} {busy}
          </Text>
        )}
        {tab === "installed" && installedDetails && (
          <InstalledDetailsView
            plugin={installedDetails}
            actions={installedDetailActions(installedDetails)}
            actionIndex={installedActionIndex}
            {...(installedNotice === null ? {} : { notice: installedNotice })}
          />
        )}
        {tab === "installed" && !installedDetails && (
          <InstalledView
            installed={installedFiltered}
            selected={searchFocused ? -1 : selectedIndex}
            favorites={favoriteIdentities}
            runtimeEnabled={runtimeEnabled}
            window={pageWindow}
            filtered={qlower.length > 0}
          />
        )}
        {tab === "marketplaces" && (
          <MarketplacesView
            marketplaces={marketplaces}
            selected={selectedIndex}
            selectedMarketplace={selectedMarketplace}
            view={marketplaceView}
            detailsSelection={detailsSelection}
            window={pageWindow}
          />
        )}
        {tab === "discover" && discoverDetails && (
          <DiscoverDetailsView item={discoverDetails} scope={installScope} />
        )}
        {tab === "discover" && !discoverDetails && (
          <DiscoverView
            discover={discoverFiltered}
            selected={searchFocused ? -1 : selectedIndex}
            marked={marked}
            window={pageWindow}
            filtered={qlower.length > 0}
          />
        )}
        {tab === "errors" && <ErrorsView />}
        {tab === "installed" && installedDetails === null && pendingReload && (
          <Box marginTop={1}>
            <Text color={Color.muted} italic>
              Run /reload to apply changes
            </Text>
          </Box>
        )}
      </Box>
    </FooterPanel>
  );
}

function PanelSubtitle({ parts }: { parts: PanelSubtitleParts }): React.JSX.Element {
  return (
    <Text>
      <Text bold>{parts.heading}</Text>
      {parts.counter !== undefined && <Text color={Color.muted}>{parts.counter}</Text>}
    </Text>
  );
}

export function buildPluginsPageRows({
  tab,
  installed,
  mcpNames,
  marketplaces,
  discover,
}: {
  tab: Tab;
  installed: readonly LoadedPlugin[];
  mcpNames?: readonly string[];
  marketplaces: readonly ReturnType<typeof listAvailableMarketplaces>[number][];
  discover: readonly DiscoverItem[];
}): PluginsPageRow[] {
  if (tab === "installed") {
    const mcpStatuses = mcpServerStatuses([...(mcpNames ?? Object.keys(gatherPluginMcpServers()))]);
    const rows: PluginsPageRow[] = [];
    let currentHeading: string | null = null;
    installed.forEach((plugin, itemIndex) => {
      const heading = installScopeHeading(findPluginInstallation(favoriteIdentity(plugin))?.scope);
      if (heading !== currentHeading) {
        currentHeading = heading;
        rows.push({
          kind: "heading",
          id: `installed-heading:${heading}`,
          label: heading,
          height: 1,
        });
      }
      rows.push({
        kind: "installed",
        id: `installed:${favoriteIdentity(plugin)}`,
        itemIndex,
        plugin,
        height: 1,
      });
    });
    if (mcpStatuses.length > 0) {
      rows.push({ kind: "heading", id: "mcp-heading", label: "MCP servers", height: 1 });
    }
    mcpStatuses.forEach((server, index) => {
      rows.push({
        kind: "mcp",
        id: `mcp:${server.name}`,
        itemIndex: installed.length + index,
        server,
        height: 1,
      });
    });
    return rows;
  }
  if (tab === "marketplaces") {
    return [
      { kind: "add-marketplace", id: "add-marketplace", itemIndex: 0, height: 2 },
      ...marketplaces.map(
        (marketplace, index): PluginsPageRow => ({
          kind: "marketplace",
          id: `marketplace:${marketplace.name}`,
          itemIndex: index + 1,
          marketplace,
          pluginCount: listMarketplacePlugins(marketplace.name).length,
          height: 4,
        }),
      ),
    ];
  }
  if (tab === "discover") {
    return discover.map(
      (item, itemIndex): PluginsPageRow => ({
        kind: "discover",
        id: `${item.marketplace}:${item.entry.name}`,
        itemIndex,
        marketplace: item.marketplace,
        entry: item.entry,
        height: 2,
      }),
    );
  }
  return [];
}
