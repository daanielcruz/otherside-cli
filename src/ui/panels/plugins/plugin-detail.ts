import { findPluginInstallation } from "@/engine/plugins/installations.ts";
import { type LoadedPlugin, resolvePluginComponents } from "@/engine/plugins/loader.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { pluginDaysSinceUse } from "@/engine/plugins/usage.ts";
import type { TerminalColor } from "@/terminal-runtime";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import {
  DETAIL_ROW_WIDTH,
  FAILED_DETAILS_HINTS,
  INSTALLED_DETAILS_HINTS,
  MENU_ROW_WIDTH,
  type PanelDetailView,
} from "@/ui/panels/plugins/chrome.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface InstalledDetailsAction {
  id: string;
  label: string;
}

/**
 * What the drill-down offers for one installed plugin. Update and uninstall only appear
 * for a plugin we installed and still track — one loaded off disk has no installation
 * record to act on.
 */
export function installedDetailActions(
  plugin: LoadedPlugin,
  favorites: ReadonlySet<string>,
): InstalledDetailsAction[] {
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

/**
 * What an action row is worth reading as, cursor or no cursor: removal is
 * destructive and reads red, an update is the offer being made and reads in the
 * focus hue. Everything else takes the row's default text colour.
 */
function actionTone(actionId: string): TerminalColor | undefined {
  if (actionId === "uninstall") return Color.error;
  if (actionId === "update") return Color.panelAccent;
  return undefined;
}

/** One installed plugin: where it came from, what it contributed, and what it offers. */
export function pluginDetailView(input: {
  plugin: LoadedPlugin;
  contentWidth: number;
  actions: readonly InstalledDetailsAction[];
  actionIndex: number;
  notice: string | null;
}): PanelDetailView {
  const { plugin, contentWidth, actions, actionIndex, notice } = input;
  const identity = plugins.pluginIdForPlugin(plugin);
  const installation = findPluginInstallation(identity);
  const enabled = plugins.isEnabledSetting(identity);
  const marketplace = installation?.marketplace ?? plugin.source;
  const components = resolvePluginComponents(plugin);
  const prefix = `plugin:${identity}:`;
  const mcpServerNames = Object.keys(gatherPluginMcpServers())
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
  const lastUsed = pluginDaysSinceUse(identity);

  const body: string[] = [];
  body.push(renderTextWithStyles(`${plugin.manifest.name} @ ${marketplace}`, { bold: true }));
  body.push(
    renderPanelRowLine(
      { label: "Scope", value: installation?.scope ?? "user", muted: true },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );
  if (plugin.manifest.version) {
    body.push(
      renderPanelRowLine(
        { label: "Version", value: plugin.manifest.version, muted: true },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }
  if (plugin.manifest.description) {
    body.push(renderTextWithStyles(plugin.manifest.description, { color: Color.text }));
  }
  if (plugin.manifest.author?.name) {
    body.push(
      renderPanelRowLine(
        { label: "Author", value: plugin.manifest.author.name, muted: true },
        contentWidth,
        DETAIL_ROW_WIDTH,
      ),
    );
  }
  let status = enabled ? "Enabled" : "Disabled";
  if (lastUsed !== undefined) {
    status +=
      lastUsed === 0
        ? " · Last used: today"
        : ` · Last used: ${lastUsed} ${lastUsed === 1 ? "day" : "days"} ago`;
  }
  body.push(
    renderPanelRowLine(
      { label: "Status", value: status, valueColor: enabled ? Color.success : Color.warning },
      contentWidth,
      DETAIL_ROW_WIDTH,
    ),
  );
  body.push("");

  const componentGroups = [
    { label: "Commands", names: components.commands.map((command) => command.name) },
    { label: "Agents", names: components.agents.map((agent) => agent.id) },
    { label: "Skills", names: components.skills.map((skill) => skill.name) },
    { label: "Hooks", names: Object.keys(components.hooks ?? {}) },
    { label: "MCP Servers", names: mcpServerNames },
  ].filter((group) => group.names.length > 0);
  if (componentGroups.length > 0) {
    body.push(renderTextWithStyles("Installed components:", { bold: true }));
    for (const group of componentGroups) {
      body.push(
        renderTextWithStyles(`${Glyph.bulletFilled} ${group.label}: ${group.names.join(", ")}`, {
          color: Color.muted,
        }),
      );
    }
    body.push("");
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const selected = i === actionIndex;
    const tone = actionTone(action.id);
    body.push(
      renderPanelRowLine(
        {
          label: action.label,
          selected,
          ...(tone === undefined
            ? {}
            : { styledLabel: renderTextWithStyles(action.label, { color: tone, bold: selected }) }),
        },
        contentWidth,
        MENU_ROW_WIDTH,
      ),
    );
  }
  if (notice) {
    body.push("");
    body.push(renderTextWithStyles(notice, { color: Color.muted }));
  }

  return { body, footerHints: INSTALLED_DETAILS_HINTS };
}

/** A plugin that would not load, with every reason it gave and how to recover. */
export function failedPluginDetailView(detail: {
  name: string;
  marketplace: string;
  errors: readonly { message: string; recoveryHint?: string }[];
}): PanelDetailView {
  const body: string[] = [];
  body.push(renderTextWithStyles(`${detail.name} @ ${detail.marketplace}`, { bold: true }));
  body.push(
    renderTextWithStyles(
      `✘ failed to load · ${detail.errors.length} ${detail.errors.length === 1 ? "error" : "errors"}`,
      { color: Color.error },
    ),
  );
  for (const error of detail.errors) {
    body.push("");
    body.push(renderTextWithStyles(error.message, { color: Color.muted }));
    if (error.recoveryHint) {
      body.push(renderTextWithStyles(error.recoveryHint, { color: Color.muted }));
    }
  }
  return { body, footerHints: FAILED_DETAILS_HINTS };
}
