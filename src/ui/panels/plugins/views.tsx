import { findPluginInstallation, type PluginInstallScope } from "@/engine/plugins/installations.ts";
import { type LoadedPlugin, resolvePluginComponents } from "@/engine/plugins/loader.ts";
import { listMarketplacePlugins } from "@/engine/plugins/marketplace.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { getSnapshot } from "@/engine/plugins/state.ts";
import { Box, Text } from "@/ink";
import { getGraphemeSegmenter } from "@/kernel/std/intl.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { ListOverflowIndicator } from "@/ui/chrome/panel.tsx";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import type { PluginsPageWindow } from "./pagination.ts";
import type { DiscoverItem, MarketplaceView } from "./types.ts";

export function InstalledView({
  installed,
  selected,
  favorites,
  runtimeEnabled,
  window,
  filtered,
}: {
  installed: readonly LoadedPlugin[];
  selected: number;
  favorites: ReadonlySet<string>;
  runtimeEnabled: ReadonlySet<string>;
  window: PluginsPageWindow;
  filtered?: boolean;
}): React.JSX.Element {
  if (installed.length === 0 && window.rows.length === 0) {
    return (
      <Text color={Color.muted}>
        {filtered ? "No plugins match your search." : "No plugins installed."}
      </Text>
    );
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
              <Box flexShrink={0}>
                <Text color={selectedRow ? Color.highlight : Color.muted}>
                  {selectedRow ? Glyph.chevron : "  "}
                </Text>
              </Box>
              {/* Single text node: sibling flex spans would shrink the name
                  below its width and wrap it into the clipped second line. */}
              <Text color={selectedRow ? Color.highlight : Color.muted} wrap="truncate-end">
                {server.name.replace(/^plugin:/, "")} MCP{" · "}
                <Text color={server.status === "connected" ? Color.success : Color.warning}>
                  {server.status === "needs-auth"
                    ? "△ Enter to auth"
                    : server.status === "connected"
                      ? `${Glyph.check} connected`
                      : server.status === "failed"
                        ? "✘ failed"
                        : "○ pending"}
                </Text>
              </Text>
            </Box>
          );
        }
        if (row.kind !== "installed") return null;
        const p = row.plugin;
        const identity = plugins.pluginIdForPlugin(p);
        const installation = findPluginInstallation(identity);
        const enabled = plugins.isEnabledSetting(identity);
        const appliedEnabled = runtimeEnabled.has(identity);
        const marketplace = installation?.marketplace ?? p.source;
        const status =
          enabled === appliedEnabled
            ? enabled
              ? `${Glyph.check} enabled`
              : `${Glyph.circleLarge} disabled`
            : enabled
              ? "→ will enable"
              : "→ will disable";
        return (
          <Box key={row.id} height={1} overflow="hidden">
            <Box flexShrink={0}>
              <Text color={selected === row.itemIndex ? Color.highlight : Color.muted}>
                {selected === row.itemIndex ? Glyph.chevron : "  "}
              </Text>
            </Box>
            {/* Single text node: sibling flex spans would shrink the name
                below its width and wrap it into the clipped second line. */}
            <Text wrap="truncate-end">
              <Text color={favorites.has(identity) ? Color.warning : Color.muted}>
                {favorites.has(identity) ? "★ " : ""}
              </Text>
              {/* The marketplace already follows as its own segment, so the
                  row shows the bare plugin name, not the @-qualified id. */}
              <Text color={selected === row.itemIndex ? Color.highlight : Color.text}>
                {p.manifest.name}
              </Text>
              <Text color={Color.muted}>{` Plugin · ${marketplace} · `}</Text>
              <Text color={enabled === appliedEnabled && enabled ? Color.success : Color.muted}>
                {status}
              </Text>
            </Text>
          </Box>
        );
      })}
    </PagedPluginsRows>
  );
}

export interface InstalledDetailsAction {
  id: string;
  label: string;
}

export function InstalledDetailsView({
  plugin,
  actions,
  actionIndex,
  notice,
}: {
  plugin: LoadedPlugin;
  actions: readonly InstalledDetailsAction[];
  actionIndex: number;
  notice?: string;
}): React.JSX.Element {
  const identity = plugins.pluginIdForPlugin(plugin);
  const installation = findPluginInstallation(identity);
  const enabled = plugins.isEnabledSetting(identity);
  const marketplace = installation?.marketplace ?? plugin.source;
  const components = resolvePluginComponents(plugin);
  const componentGroups = [
    { label: "Commands", names: components.commands.map((command) => command.name) },
    { label: "Agents", names: components.agents.map((agent) => agent.id) },
    { label: "Skills", names: components.skills.map((skill) => skill.name) },
    { label: "Hooks", names: Object.keys(components.hooks ?? {}) },
  ].filter((group) => group.names.length > 0);
  return (
    <Box flexDirection="column">
      <Text bold>
        {plugin.manifest.name} @ {marketplace}
      </Text>
      <Box>
        <Text color={Color.muted}>Scope: </Text>
        <Text>{installation?.scope ?? "user"}</Text>
      </Box>
      {plugin.manifest.version && (
        <Box>
          <Text color={Color.muted}>Version: </Text>
          <Text>{plugin.manifest.version}</Text>
        </Box>
      )}
      {plugin.manifest.description && <Text>{plugin.manifest.description}</Text>}
      {plugin.manifest.author?.name && (
        <Box marginTop={1}>
          <Text color={Color.muted}>Author: </Text>
          <Text>{plugin.manifest.author.name}</Text>
        </Box>
      )}
      <Box marginTop={1} marginBottom={componentGroups.length > 0 ? 0 : 1}>
        <Text color={Color.muted}>Status: </Text>
        <Text color={enabled ? Color.success : Color.warning}>
          {enabled ? "Enabled" : "Disabled"}
        </Text>
      </Box>
      {componentGroups.length > 0 && (
        <Box marginBottom={2} flexDirection="column">
          <Text bold>Installed components:</Text>
          {componentGroups.map((group) => (
            <Text key={group.label}>
              {Glyph.bulletFilled}{" "}
              <Text color={Color.muted}>
                {group.label}: {group.names.join(", ")}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column">
        {actions.map((action, index) => {
          const selected = index === actionIndex;
          const color =
            action.id === "uninstall"
              ? Color.error
              : action.id === "update"
                ? Color.highlight
                : undefined;
          return (
            <Box key={action.id}>
              <Text color={selected ? undefined : Color.muted}>
                {selected ? Glyph.chevron : "  "}
              </Text>
              <Text bold={selected} color={selected ? undefined : color}>
                {action.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text color={Color.muted}>{notice}</Text>
        </Box>
      )}
    </Box>
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
          <Text color={Color.muted}>
            {" "}
            • Updated {formatMarketplaceDate(selectedMarketplace.lastUpdated)}
          </Text>
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
          <Box key={row.id} flexDirection="column" height={4} overflow="hidden">
            <Box height={1} overflow="hidden">
              <Box flexShrink={0}>
                <Text color={selectedRow ? Color.highlight : Color.muted}>
                  {selectedRow ? Glyph.chevron : "  "}
                </Text>
                <Text color={Color.muted}>{Glyph.bulletFilled} </Text>
              </Box>
              <Text bold color={selectedRow ? Color.highlight : Color.text} wrap="truncate-end">
                {m.name}
              </Text>
            </Box>
            <Box height={2} paddingLeft={4} overflow="hidden">
              <Text color={Color.muted} wrap="wrap">
                {m.source}
              </Text>
            </Box>
            <Box height={1} paddingLeft={4} overflow="hidden">
              <Text color={Color.muted} wrap="truncate-end">
                {row.pluginCount} available • Updated {formatMarketplaceDate(m.lastUpdated)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </PagedPluginsRows>
  );
}

function formatMarketplaceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
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

export const DISCOVER_DESCRIPTION_WIDTH = 60;

export function DiscoverDetailsView({
  item,
  scope,
}: {
  item: DiscoverItem;
  scope: PluginInstallScope;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text color={Color.textStrong} bold>
          {item.entry.name}
        </Text>
        <Text color={Color.muted}>from {item.marketplace}</Text>
      </Box>
      {item.entry.description && (
        <Box marginTop={1}>
          <Text>{item.entry.description}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text>Will install:</Text>
        <Text color={Color.muted}>· Components will be discovered at installation</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Color.warning}>
          ⚠ Make sure you trust a plugin before installing, updating, or using it. Anthropic does
          not control what MCP servers, files, or other software are included in plugins and cannot
          verify that they will work as intended or that they won't change. See each plugin's
          homepage for more information.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {INSTALL_SCOPES.map((candidate) => (
          <Box key={candidate}>
            <Text color={candidate === scope ? Color.highlight : Color.muted}>
              {candidate === scope ? Glyph.chevron : "  "}
            </Text>
            <Text color={candidate === scope ? Color.highlight : Color.text}>
              {candidate === "user"
                ? "Install for you (user scope)"
                : candidate === "project"
                  ? "Install for all collaborators on this repository (project scope)"
                  : "Install for you, in this repo only (local scope)"}
            </Text>
          </Box>
        ))}
        <Text color={Color.muted}> Back to plugin list</Text>
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
    <Box flexDirection="column">
      {window.aboveItems > 0 && (
        <ListOverflowIndicator direction="up" suffix="above" paddingLeft={1} />
      )}
      {window.rows.map((row, rowIndex) => {
        if (row.kind !== "discover") return null;
        const key = row.id;
        return (
          <Box
            key={key}
            flexDirection="column"
            height={row.height}
            marginBottom={rowIndex === window.rows.length - 1 ? 0 : 1}
            overflow="hidden"
          >
            <Box height={1} overflow="hidden">
              <Box flexShrink={0}>
                <Text color={selected === row.itemIndex ? Color.highlight : undefined}>
                  {selected === row.itemIndex ? Glyph.chevron : "  "}
                </Text>
              </Box>
              {/* Single text node: sibling flex spans would shrink the name
                  below its width and wrap it into the clipped second line. */}
              <Text wrap="truncate-end">
                {marked.has(key) ? Glyph.radioOn : Glyph.circleLarge} {row.entry.name}
                <Text color={Color.muted}>
                  {` · ${row.marketplace}`}
                  {row.entry.communityManaged || row.entry.tags?.includes("community-managed")
                    ? " [Community Managed]"
                    : ""}
                  {row.entry.installCount !== undefined
                    ? ` · ${formatInstallCount(row.entry.installCount)} installs`
                    : ""}
                </Text>
              </Text>
            </Box>
            <Box height={1} paddingLeft={4} overflow="hidden">
              {row.entry.description && (
                <Text color={Color.muted} wrap="truncate-end">
                  {truncateDiscoverDescription(row.entry.description)}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
      {window.belowItems > 0 && (
        <ListOverflowIndicator direction="down" suffix="below" paddingLeft={1} />
      )}
    </Box>
  );
}

export function truncateDiscoverDescription(
  description: string,
  width: number = DISCOVER_DESCRIPTION_WIDTH,
): string {
  if (stringWidth(description) <= width) return description;
  const ellipsis = "…";
  const contentWidth = Math.max(0, width - stringWidth(ellipsis));
  let used = 0;
  let truncated = "";
  for (const { segment } of getGraphemeSegmenter().segment(description)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > contentWidth) break;
    truncated += segment;
    used += segmentWidth;
  }
  return `${truncated}${ellipsis}`;
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
      <Box height={1} overflow="hidden">
        {window.aboveItems > 0 && (
          <ListOverflowIndicator
            direction="up"
            count={window.aboveItems}
            suffix="above"
            paddingLeft={2}
          />
        )}
      </Box>
      {children}
      <Box height={1} overflow="hidden">
        {window.belowItems > 0 && (
          <ListOverflowIndicator
            direction="down"
            count={window.belowItems}
            suffix="below"
            paddingLeft={2}
          />
        )}
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
  const { errors } = getSnapshot();
  if (errors.length === 0) return <Text color={Color.muted}>No plugin errors.</Text>;
  return (
    <Box flexDirection="column">
      {errors.map((error) => (
        <Box
          key={`${error.pluginId ?? "unknown"}:${error.path}:${error.code}`}
          flexDirection="column"
        >
          <Text color={Color.error} wrap="truncate-end">
            {error.pluginId ?? "unknown plugin"} · {error.code}
          </Text>
          <Text color={Color.muted} wrap="truncate-end">
            {error.path} · {error.message}
          </Text>
          <Text color={Color.muted} wrap="truncate-end">
            {error.recoveryHint}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
