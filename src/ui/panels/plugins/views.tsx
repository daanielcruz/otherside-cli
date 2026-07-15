import { findPluginInstallation, type PluginInstallScope } from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import { listMarketplacePlugins } from "@/engine/plugins/marketplace.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { Box, Text } from "@/ink";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import type { PluginsPageWindow } from "./pagination.ts";
import type { DiscoverItem, MarketplaceView } from "./types.ts";

export function InstalledView({
  installed,
  selected,
  favorites,
  window,
}: {
  installed: readonly LoadedPlugin[];
  selected: number;
  favorites: ReadonlySet<string>;
  window: PluginsPageWindow;
}): React.JSX.Element {
  if (installed.length === 0 && window.rows.length === 0) {
    return <Text color={Color.muted}>No plugins installed.</Text>;
  }
  return (
    <PagedPluginsRows window={window}>
      {window.rows.map((row) => {
        if (row.kind === "heading") {
          return (
            <Text key={row.id} color={Color.muted} wrap="truncate-end">
              {row.label}
            </Text>
          );
        }
        if (row.kind === "mcp") {
          const server = row.server;
          const selectedRow = selected === row.itemIndex;
          return (
            <Box key={row.id} height={1} overflow="hidden">
              <Text color={selectedRow ? Color.highlight : Color.muted}>
                {selectedRow ? Glyph.chevron : "  "}
              </Text>
              <Text color={selectedRow ? Color.highlight : Color.muted} wrap="truncate-end">
                {server.name.replace(/^plugin:/, "")} MCP ·
              </Text>
              <Text color={server.status === "connected" ? Color.success : Color.warning}>
                {server.status === "needs-auth"
                  ? "△ Enter to auth"
                  : server.status === "connected"
                    ? `${Glyph.check} connected`
                    : server.status === "failed"
                      ? "✘ failed"
                      : "○ pending"}
              </Text>
            </Box>
          );
        }
        if (row.kind !== "installed") return null;
        const p = row.plugin;
        const installation = findPluginInstallation(p.name);
        const identity = installation?.identity ?? p.name;
        const enabled = plugins.isEnabled(identity);
        const marketplace = installation?.marketplace ?? p.source;
        return (
          <Box key={row.id} height={1} overflow="hidden">
            <Text color={selected === row.itemIndex ? Color.highlight : Color.muted}>
              {selected === row.itemIndex ? Glyph.chevron : "  "}
            </Text>
            <Text color={favorites.has(p.name) ? Color.warning : Color.muted}>
              {favorites.has(p.name) ? "★ " : ""}
            </Text>
            <Text color={selected === row.itemIndex ? Color.highlight : Color.text}>{p.name}</Text>
            <Text color={Color.muted} wrap="truncate-end">
              {` Plugin · ${marketplace} · `}
            </Text>
            <Text color={enabled ? Color.success : Color.muted}>
              {enabled ? `${Glyph.check} enabled` : `${Glyph.circleLarge} disabled`}
            </Text>
          </Box>
        );
      })}
    </PagedPluginsRows>
  );
}

export function MarketplacesView({
  marketplaces,
  selected,
  selectedMarketplace,
  view,
  detailsSelection,
  window,
}: {
  marketplaces: readonly KnownMarketplace[];
  selected: number;
  selectedMarketplace: KnownMarketplace | undefined;
  view: MarketplaceView;
  detailsSelection: number;
  window: PluginsPageWindow;
}): React.JSX.Element {
  if (view === "confirm-remove" && selectedMarketplace) {
    return (
      <Box flexDirection="column">
        <Text color={Color.warning} bold>
          Remove marketplace <Text italic>{selectedMarketplace.name}</Text>?
        </Text>
        <Box marginTop={1}>
          <Text color={Color.warning}>This removes the marketplace from the configured list.</Text>
        </Box>
      </Box>
    );
  }
  if (view === "details" && selectedMarketplace) {
    const pluginCount = listMarketplacePlugins(selectedMarketplace.name).length;
    return (
      <Box flexDirection="column">
        <Text bold>{selectedMarketplace.name}</Text>
        <Text color={Color.muted}>{selectedMarketplace.source}</Text>
        <Box marginTop={1}>
          <Text color={Color.muted}>{pluginCount} available</Text>
          <Text color={Color.muted}> · Updated {selectedMarketplace.lastUpdated.slice(0, 10)}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <MarketplaceActionRow selected={detailsSelection === 0} label="Update marketplace" />
          <MarketplaceActionRow selected={detailsSelection === 1} label="Remove marketplace" />
        </Box>
      </Box>
    );
  }
  return (
    <PagedPluginsRows window={window}>
      {window.rows.map((row) => {
        if (row.kind === "marketplace-heading") {
          return (
            <Text key={row.id} color={Color.textStrong} bold wrap="truncate-end">
              {row.label}
            </Text>
          );
        }
        if (row.kind === "add-marketplace") {
          return (
            <Box key={row.id} height={2} paddingTop={1} overflow="hidden">
              <Text color={selected === 0 ? Color.highlight : Color.muted}>
                {selected === 0 ? Glyph.chevron : "  "}
              </Text>
              <Text color={selected === 0 ? Color.highlight : Color.textStrong} bold>
                + Add Marketplace
              </Text>
            </Box>
          );
        }
        if (row.kind !== "marketplace") return null;
        const m = row.marketplace;
        const selectedRow = selected === row.itemIndex;
        return (
          <Box key={row.id} flexDirection="column" height={3} overflow="hidden">
            <Box height={1} overflow="hidden">
              <Text color={selectedRow ? Color.highlight : Color.muted}>
                {selectedRow ? Glyph.chevron : "  "}
              </Text>
              <Text color={Color.muted}>{Glyph.bulletFilled} </Text>
              <Text bold color={selectedRow ? Color.highlight : Color.text} wrap="truncate-end">
                {m.name}
              </Text>
            </Box>
            <Box height={1} paddingLeft={4} overflow="hidden">
              <Text color={Color.muted} wrap="truncate-end">
                {m.source}
              </Text>
            </Box>
            <Box height={1} paddingLeft={4} overflow="hidden">
              <Text color={Color.muted} wrap="truncate-end">
                {row.pluginCount} available · Updated {m.lastUpdated.slice(0, 10)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </PagedPluginsRows>
  );
}

function MarketplaceActionRow({
  selected,
  label,
}: {
  selected: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? Color.highlight : Color.muted}>
        {selected ? Glyph.chevron : "  "}
      </Text>
      <Text color={selected ? Color.highlight : Color.text}>{label}</Text>
    </Box>
  );
}

export const INSTALL_SCOPES: readonly PluginInstallScope[] = ["user", "project", "local"];

export function DiscoverDetailsView({
  item,
  scope,
}: {
  item: DiscoverItem;
  scope: PluginInstallScope;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={Color.textStrong} bold>
        {item.entry.name}
      </Text>
      <Text color={Color.muted}>Plugin · {item.marketplace}</Text>
      {item.entry.description && (
        <Box marginTop={1}>
          <Text>{item.entry.description}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Color.warning}>
          Plugins can run code, hooks, and MCP servers. Only install plugins you trust.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={Color.muted}>Install scope</Text>
        {INSTALL_SCOPES.map((candidate) => (
          <Box key={candidate}>
            <Text color={candidate === scope ? Color.highlight : Color.muted}>
              {candidate === scope ? Glyph.chevron : "  "}
            </Text>
            <Text color={candidate === scope ? Color.highlight : Color.text}>
              {candidate === "user"
                ? "User (available in all projects)"
                : candidate === "project"
                  ? "Project (shared with collaborators)"
                  : "Local (this project only)"}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function DiscoverView({
  discover,
  selected,
  marked,
  window,
  filtered,
}: {
  discover: readonly DiscoverItem[];
  selected: number;
  marked: ReadonlySet<string>;
  window: PluginsPageWindow;
  filtered: boolean;
}): React.JSX.Element {
  if (discover.length === 0) {
    return (
      <Text color={Color.muted}>
        {filtered
          ? "No plugins match your search."
          : "No plugins to discover. Add a marketplace first."}
      </Text>
    );
  }
  return (
    <PagedPluginsRows window={window}>
      {window.rows.map((row) => {
        if (row.kind !== "discover") return null;
        const key = row.id;
        return (
          <Box key={key} flexDirection="column" height={row.height} overflow="hidden">
            <Box height={1} overflow="hidden">
              <Text color={selected === row.itemIndex ? Color.highlight : Color.muted}>
                {selected === row.itemIndex ? Glyph.chevron : "  "}
              </Text>
              <Text color={Color.muted}>
                {marked.has(key) ? Glyph.radioOn : Glyph.circleLarge}{" "}
              </Text>
              <Text color={selected === row.itemIndex ? Color.highlight : Color.text}>
                {row.entry.name}
              </Text>
              <Text color={Color.muted} wrap="truncate-end">
                {` · ${row.marketplace}`}
                {row.entry.communityManaged ? " [Community Managed]" : ""}
                {row.entry.installCount !== undefined
                  ? ` · ${formatInstallCount(row.entry.installCount)} installs`
                  : ""}
              </Text>
            </Box>
            <Box height={1} paddingLeft={4} overflow="hidden">
              {row.entry.description && (
                <Text color={Color.muted} wrap="truncate-end">
                  {row.entry.description}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </PagedPluginsRows>
  );
}

function PagedPluginsRows({
  window,
  children,
}: {
  window: PluginsPageWindow;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box height={1} paddingLeft={2} overflow="hidden">
        {window.aboveItems > 0 && <Text color={Color.muted}>↑ {window.aboveItems} more above</Text>}
      </Box>
      {children}
      <Box height={1} paddingLeft={2} overflow="hidden">
        {window.belowItems > 0 && <Text color={Color.muted}>↓ {window.belowItems} more below</Text>}
      </Box>
    </Box>
  );
}

function formatInstallCount(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}K`;
  return String(count);
}

export function ErrorsView(): React.JSX.Element {
  return <Text color={Color.muted}>No plugin errors.</Text>;
}
