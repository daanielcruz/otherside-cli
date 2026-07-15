import { useEffect, useState } from "react";
import { publish } from "@/engine/background/tasks/bus.ts";
import {
  findPluginInstallationByPath,
  type PluginInstallScope,
} from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import {
  addMarketplace,
  installMarketplacePlugin,
  listMarketplacePlugins,
  refreshOfficialCatalog,
} from "@/engine/plugins/marketplace.ts";
import {
  listAvailableMarketplaces,
  removeKnownMarketplace,
} from "@/engine/plugins/marketplaces-store.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { mcpServerStatuses } from "@/kernel/mcp/client/registry.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { consumePendingPluginCommandResult } from "@/ui/panels/plugins/command-result.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { footerHintsFor, subtitleFor, TAB_LABELS } from "./chrome.ts";
import {
  clampPluginsIndex,
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

function favoriteIdentity(plugin: Pick<LoadedPlugin, "name" | "path">): string {
  return findPluginInstallationByPath(plugin.path)?.identity ?? plugin.name;
}

export function PluginsOverlay({
  onClose,
  commandResult: commandResultProp,
}: PluginsOverlayProps = {}): React.JSX.Element {
  const { columns, rows: terminalRows } = useTerminalDimensions();
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
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => loadFavoriteNames());
  const [commandResult] = useState<string | null>(
    () => commandResultProp ?? consumePendingPluginCommandResult(),
  );
  const [catalogTick, setCatalogTick] = useState(0);

  const installed = plugins.list();
  const favoriteNames = new Set(
    installed
      .filter((plugin) => favorites.has(favoriteIdentity(plugin)))
      .map((plugin) => plugin.name),
  );
  const marketplaces = listAvailableMarketplaces();
  // Discover entries come from marketplace checkouts (official fixed-pointer
  // clone bootstrapped on demand). The plugin-stats catalog only overlays
  // install counts; the bundled seed is an offline-only entry fallback.
  const discover: DiscoverItem[] = [];
  for (const mp of marketplaces) {
    for (const entry of listMarketplacePlugins(mp.name)) {
      discover.push({ marketplace: mp.name, entry });
    }
  }
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

  const installedMcpCount = tab === "installed" ? Object.keys(gatherPluginMcpServers()).length : 0;
  const count =
    tab === "installed"
      ? installed.length + installedMcpCount
      : tab === "marketplaces"
        ? marketplaces.length + 1
        : discoverFiltered.length;
  const selectedIndex = clampPluginsIndex(selected, count);
  const selectedMarketplace =
    tab === "marketplaces" && selectedIndex > 0 ? marketplaces[selectedIndex - 1] : undefined;
  const footerHints =
    discoverDetails !== null
      ? ([
          ["↑/↓", "scope"],
          ["Enter", "install"],
          ["Esc", "back"],
        ] satisfies [string, string][])
      : footerHintsFor(tab, marketplaceView);
  const listVisible =
    (tab === "discover" && discoverDetails === null) ||
    tab === "installed" ||
    (tab === "marketplaces" && marketplaceView === "list");
  const listRows = listVisible
    ? pluginsPageRows(terminalRows, {
        searchVisible: tab === "discover",
        commandResult: commandResult !== null,
        busy: busy !== null,
        footerRows: pluginsFooterRows(columns, footerHints),
      })
    : 1;
  const pageRows = buildPluginsPageRows({
    tab,
    installed,
    marketplaces,
    discover: discoverFiltered,
  });
  const pageWindow = pluginsPageWindow(pageRows, selectedIndex, listRows);

  useEffect(() => {
    setSelected(0);
    setQuery("");
    setSearchFocused(false);
    setMarketplaceView("list");
    setDetailsSelection(0);
    setDiscoverDetails(null);
    setInstallScope("user");
  }, [tab]);

  useEffect(() => {
    setSelected((idx) => clampPluginsIndex(idx, count));
  }, [count, listRows]);

  // Best-effort install-counts refresh (reference: pluginCatalogCache 24h TTL).
  // Entries stay sourced from the checkout/offline-seed path; only counts update.
  useEffect(() => {
    let cancelled = false;
    void refreshOfficialCatalog().then((catalog) => {
      if (!cancelled && catalog) setCatalogTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleInstalled(name: string): Promise<void> {
    const next = !plugins.isEnabled(name);
    setBusy(`${next ? "Enabling" : "Disabling"} ${name}`);
    await plugins.setEnabled(name, next);
    setBusy(null);
    publish("success", `${next ? "Enabled" : "Disabled"} plugin ${name}`);
  }

  async function installBatch(
    items: DiscoverItem[],
    scope: PluginInstallScope = "user",
  ): Promise<void> {
    if (items.length === 0) return;
    setBusy(`Installing ${items.length} plugin${items.length === 1 ? "" : "s"}`);
    let ok = 0;
    for (const it of items) {
      if (installMarketplacePlugin(it.marketplace, it.entry.name, scope).success) ok += 1;
    }
    setBusy(null);
    setMarked(new Set());
    setDiscoverDetails(null);
    if (ok > 0) {
      publish("success", `Installed ${ok} plugin${ok === 1 ? "" : "s"} in ${scope} scope.`);
    } else {
      publish("error", "No plugins installed.");
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
    if (tab === "discover" && (searchFocused || query.length > 0)) {
      setQuery("");
      setSearchFocused(false);
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
        const target = selectedInstalledPlugin(installed, selectedIndex);
        if (!target) return false;
        if (key.return || input === " ") {
          void toggleInstalled(target.name);
          return true;
        }
        if (input === "f" || input === "F") {
          setFavorites((previous) => {
            const identity = favoriteIdentity(target);
            const next = new Set(previous);
            if (next.has(identity)) next.delete(identity);
            else next.add(identity);
            persistFavorites(next);
            return next;
          });
          return true;
        }
        return false;
      }
      if (tab === "discover") {
        if (key.backspace || key.delete) {
          if (searchFocused && query.length > 0) {
            setQuery((v) => v.slice(0, -1));
            return true;
          }
          return false;
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
        if (item && (key.return || (!searchFocused && (input === "i" || input === "I")))) {
          setDiscoverDetails(item);
          setInstallScope("user");
          setSearchFocused(false);
          return true;
        }
        if (!searchFocused && input === "/") {
          setSearchFocused(true);
          return true;
        }
        if (input && input !== " " && !key.return && !key.ctrl && !key.meta) {
          setSearchFocused(true);
          setQuery((v) => v + input);
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
      tabs={TABS.map((t) => ({ label: TAB_LABELS[t] }))}
      activeTab={TABS.indexOf(tab)}
      subtitle={subtitleFor(tab, {
        discover: discoverFiltered.length,
        installed: installed.length,
        marketplaces: marketplaces.length,
        selected: selectedIndex,
      })}
      tabsFocused
      search={
        tab === "discover" && !discoverDetails
          ? { query, placeholder: "Search…", focused: searchFocused }
          : undefined
      }
      flushTop
      onCancel={cancelPanel}
      disableCancelKey
      footerHints={footerHints}
    >
      <Box flexDirection="column" marginTop={1}>
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
        {tab === "installed" && (
          <InstalledView
            installed={installed}
            selected={selectedIndex}
            favorites={favoriteNames}
            window={pageWindow}
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
            selected={selectedIndex}
            marked={marked}
            window={pageWindow}
            filtered={qlower.length > 0}
          />
        )}
        {tab === "errors" && <ErrorsView />}
      </Box>
    </FooterPanel>
  );
}

export function buildPluginsPageRows({
  tab,
  installed,
  marketplaces,
  discover,
}: {
  tab: Tab;
  installed: readonly LoadedPlugin[];
  marketplaces: readonly ReturnType<typeof listAvailableMarketplaces>[number][];
  discover: readonly DiscoverItem[];
}): PluginsPageRow[] {
  if (tab === "installed") {
    const mcpNames = Object.keys(gatherPluginMcpServers());
    const mcpStatuses = mcpServerStatuses(mcpNames);
    return [
      ...(installed.length > 0
        ? ([
            { kind: "heading", id: "installed-heading", label: "User", height: 1 },
          ] satisfies PluginsPageRow[])
        : []),
      ...installed.map(
        (plugin, itemIndex): PluginsPageRow => ({
          kind: "installed",
          id: `installed:${favoriteIdentity(plugin)}`,
          itemIndex,
          plugin,
          height: 1,
        }),
      ),
      ...(mcpStatuses.length > 0
        ? ([
            { kind: "heading", id: "mcp-heading", label: "MCP servers", height: 1 },
          ] satisfies PluginsPageRow[])
        : []),
      ...mcpStatuses.map(
        (server, index): PluginsPageRow => ({
          kind: "mcp",
          id: `mcp:${server.name}`,
          itemIndex: installed.length + index,
          server,
          height: 1,
        }),
      ),
    ];
  }
  if (tab === "marketplaces") {
    return [
      {
        kind: "marketplace-heading",
        id: "marketplace-heading",
        label: "Manage marketplaces",
        height: 1,
      },
      { kind: "add-marketplace", id: "add-marketplace", itemIndex: 0, height: 2 },
      ...marketplaces.map(
        (marketplace, index): PluginsPageRow => ({
          kind: "marketplace",
          id: `marketplace:${marketplace.name}`,
          itemIndex: index + 1,
          marketplace,
          pluginCount: listMarketplacePlugins(marketplace.name).length,
          height: 3,
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
