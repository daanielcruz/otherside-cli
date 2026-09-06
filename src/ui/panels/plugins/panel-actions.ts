import {
  changeEnabledWithDependencies,
  registryDependencyPlugins,
  reverseDependents,
} from "@/engine/plugins/dependencies.ts";
import { removePlugin } from "@/engine/plugins/install.ts";
import { findPluginInstallation, type PluginInstallScope } from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import {
  installMarketplacePlugin,
  updateMarketplacePlugin,
} from "@/engine/plugins/marketplace-install.ts";
import { listAvailableMarketplaces } from "@/engine/plugins/marketplaces-store.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import { cycleSkillState, setSkillState } from "@/engine/skills/overrides.ts";
import { list as listSkills } from "@/engine/skills/registry.ts";
import type { SkillState } from "@/kernel/config/config.ts";
import { openBrowser } from "@/kernel/std/browser.ts";
import { persistFavorites } from "@/ui/panels/plugins/favorites.ts";
import { MarketplaceActions } from "@/ui/panels/plugins/marketplace-actions.ts";
import { McpActions } from "@/ui/panels/plugins/mcp-actions.ts";
import {
  LIVE_PANEL_IO,
  operationLine,
  type PanelHost,
  type PanelIo,
  publishPluginResult,
  setPanelBusy,
  withReloadHint,
} from "@/ui/panels/plugins/panel-actions-support.ts";
import { favoriteIdentity } from "@/ui/panels/plugins/panel-model.ts";
import {
  type PanelEffect,
  type SkillItem,
  withData,
  withDiscover,
  withInstalled,
  withNav,
} from "@/ui/panels/plugins/panel-state.ts";
import type { DiscoverItem } from "@/ui/panels/plugins/types.ts";

export type { PanelHost, PanelIo } from "@/ui/panels/plugins/panel-actions-support.ts";
export { LIVE_PANEL_IO } from "@/ui/panels/plugins/panel-actions-support.ts";

/** The async half of the panel: every effect the pure key layer can request. */
export class PanelActions {
  private catalogReloadKey = 0;
  private readonly mcp: McpActions;
  private readonly marketplaces: MarketplaceActions;

  constructor(
    private readonly host: PanelHost,
    private readonly io: PanelIo = LIVE_PANEL_IO,
  ) {
    const onDataChanged = (): void => this.bump();
    this.mcp = new McpActions(host, io, onDataChanged);
    this.marketplaces = new MarketplaceActions(host, onDataChanged);
  }

  /** Invalidate in-flight loads; the host calls this on unmount. */
  invalidate(): void {
    this.catalogReloadKey += 1;
    this.mcp.invalidate();
  }

  run(effect: PanelEffect): void {
    switch (effect.kind) {
      case "close":
        this.host.close();
        return;
      case "install-batch":
        void this.installBatch(effect.items, effect.scope ?? "user");
        return;
      case "open-browser":
        void openBrowser(effect.url);
        return;
      case "run-detail-action":
        void this.runInstalledDetailAction(effect.plugin, effect.actionId);
        return;
      case "apply-skill-state":
        this.applySkillState(effect.item, effect.state);
        return;
      case "cycle-skill":
        this.cycleInstalledSkill(effect.item);
        return;
      case "toggle-plugin":
        void this.toggleInstalled(effect.pluginId);
        return;
      case "toggle-favorite":
        this.toggleFavorite(effect.plugin);
        return;
      case "toggle-mcp":
        void this.mcp.toggleMcpEnabled(effect.fullName, effect.currentlyEnabled);
        return;
      case "open-mcp-detail":
        void this.mcp.openMcpDetail(effect.fullName);
        return;
      case "authenticate-mcp":
        void this.mcp.authenticateMcp(effect.fullName);
        return;
      case "run-mcp-option":
        void this.mcp.runMcpDetailOption(effect.server, effect.optionId);
        return;
      case "submit-add-marketplace":
        void this.marketplaces.submitAddMarketplace();
        return;
      case "update-marketplace":
        void this.marketplaces.updateMarketplace(effect.source, effect.inDetail);
        return;
      case "remove-marketplace":
        this.marketplaces.removeMarketplace(effect.name);
        return;
      case "load-standalone-mcp":
        void this.mcp.loadStandaloneMcp();
        return;
    }
  }

  async refreshCatalog(): Promise<void> {
    const key = ++this.catalogReloadKey;
    const catalog = await this.io.refreshCatalog();
    if (key !== this.catalogReloadKey || this.host.isCancelled()) return;
    if (catalog) this.bump();
  }

  async loadStandaloneMcp(): Promise<void> {
    await this.mcp.loadStandaloneMcp();
  }

  /** A data change invalidates the projected registries; installed reloads its MCP list. */
  private bump(): void {
    this.host.setState((state) => withData(state, { catalogTick: state.data.catalogTick + 1 }));
    if (this.host.getState().nav.tab === "installed") void this.mcp.loadStandaloneMcp();
    this.host.requestRender();
  }

  private async runInstalledDetailAction(plugin: LoadedPlugin, actionId: string): Promise<void> {
    const pluginId = plugins.pluginIdForPlugin(plugin);
    if (actionId === "back") {
      this.host.setState((state) =>
        withInstalled(state, { actionIndex: 0, notice: null, detail: { kind: "list" } }),
      );
      this.host.requestRender();
      return;
    }
    if (actionId === "favorite") {
      this.toggleFavorite(plugin);
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
      const enabling = !plugins.isEnabledSetting(pluginId);
      if (await this.toggleInstalled(pluginId)) {
        this.finishInPanel(operationLine(enabling ? "Enabled" : "Disabled", plugin.manifest.name));
      }
      return;
    }
    if (actionId === "mark-update") {
      const installation = findPluginInstallation(pluginId);
      const marketplace = listAvailableMarketplaces().find(
        (candidate) => candidate.name === installation?.marketplace,
      );
      if (marketplace?.sourceType === "file") {
        this.host.setState((state) =>
          withInstalled(state, {
            notice: `Local plugins cannot be updated remotely. To update, modify the source at: ./plugins/${plugin.manifest.name}`,
          }),
        );
        this.host.requestRender();
      }
      return;
    }
    if (actionId === "update") {
      const installation = findPluginInstallation(pluginId);
      setPanelBusy(this.host, `Updating ${pluginId}`);
      const res = updateMarketplacePlugin(pluginId, undefined, installation?.installationId);
      setPanelBusy(this.host, null);
      publishPluginResult(withReloadHint(res.message, res.success), !res.success);
      this.bump();
      return;
    }
    if (actionId === "uninstall") {
      setPanelBusy(this.host, `Uninstalling ${pluginId}`);
      const dependents = reverseDependents(pluginId, registryDependencyPlugins());
      const res = await removePlugin(pluginId);
      if (this.host.isCancelled()) return;
      this.host.setState((state) => withData(state, { busy: null }));
      if (!res.success) {
        publishPluginResult(res.message, true);
        this.host.requestRender();
        return;
      }
      this.host.setState((state) => {
        const uninstalled = new Set(state.data.uninstalled);
        uninstalled.add(pluginId);
        return withNav(withData(state, { uninstalled }), { selected: 0 });
      });
      this.finishInPanel(operationLine("Uninstalled", plugin.manifest.name, dependents));
    }
  }

  /**
   * The oracle's in-panel outcome: the operation's line lands green above the tab
   * list and the drill-down folds back into it. Nothing reaches the transcript —
   * only work that outlives the overlay (install, update) is anchored there.
   */
  private finishInPanel(message: string): void {
    this.host.setState((state) =>
      withInstalled(withData(state, { commandResult: message }), {
        actionIndex: 0,
        notice: null,
        detail: { kind: "list" },
      }),
    );
    this.host.requestRender();
  }

  /** @returns whether the enabled state actually changed. */
  private async toggleInstalled(pluginId: string): Promise<boolean> {
    const next = !plugins.isEnabledSetting(pluginId);
    setPanelBusy(this.host, `${next ? "Enabling" : "Disabling"} ${pluginId}`);
    const result = await changeEnabledWithDependencies(pluginId, next);
    if (this.host.isCancelled()) return false;
    this.host.setState((state) => withData(state, { busy: null }));
    if (!result.success) publishPluginResult(result.message, true);
    this.bump();
    return result.success;
  }

  private toggleFavorite(plugin: LoadedPlugin): void {
    const identity = favoriteIdentity(plugin);
    this.host.setState((state) => {
      const favorites = new Set(state.data.favorites);
      if (favorites.has(identity)) favorites.delete(identity);
      else favorites.add(identity);
      persistFavorites(favorites);
      return withData(state, { favorites });
    });
    this.host.requestRender();
  }

  private applySkillState(item: SkillItem, next: SkillState): void {
    const skill = listSkills().find((candidate) => candidate.name === item.name);
    if (!skill) return;
    const resolved = item.authorLocked && next !== "off" ? "user-invocable-only" : next;
    setSkillState(skill, resolved);
    this.host.setState((state) => {
      const keep = new Set(state.installed.keepInPlaceIds);
      keep.add(item.id);
      return withInstalled(state, {
        keepInPlaceIds: keep,
        detail: { kind: "skill", item: { ...item, state: resolved } },
      });
    });
    this.bump();
  }

  private cycleInstalledSkill(item: SkillItem): void {
    const skill = listSkills().find((candidate) => candidate.name === item.name);
    if (!skill) return;
    cycleSkillState(skill);
    this.host.setState((state) => {
      const keep = new Set(state.installed.keepInPlaceIds);
      keep.add(item.id);
      return withInstalled(state, { keepInPlaceIds: keep });
    });
    this.bump();
  }

  private async installBatch(items: DiscoverItem[], scope: PluginInstallScope): Promise<void> {
    if (items.length === 0) return;
    setPanelBusy(this.host, `Installing ${items.length} plugin${items.length === 1 ? "" : "s"}`);
    const results = items.map((item) =>
      installMarketplacePlugin(item.marketplace, item.entry.name, scope),
    );
    const installed = results.filter((result) => result.success);
    if (this.host.isCancelled()) return;
    this.host.setState((state) =>
      withDiscover(withData(state, { busy: null }), { marked: new Set(), details: null }),
    );
    if (installed.length >= 1) {
      const feedback =
        installed.length === 1
          ? "✓ Installed 1 plugin. Run /reload to activate."
          : `✓ Installed ${installed.length} plugins. Run /reload to activate.`;
      publishPluginResult(feedback);
      this.host.close();
      return;
    }
    const failure = results[0]?.message ?? "No plugins installed.";
    publishPluginResult(failure, true);
    this.host.requestRender();
  }
}
