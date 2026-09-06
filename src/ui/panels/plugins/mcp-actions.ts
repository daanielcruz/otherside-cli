import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import { mcpServerStatuses } from "@/kernel/mcp/client/registry.ts";
import { disableMcpServer, enableMcpServer } from "@/kernel/mcp/config.ts";
import { dropClient, startOAuthFlow } from "@/kernel/mcp/index.ts";
import { isRemote, type McpServerRow, resolveInspection } from "@/ui/panels/mcp/data.ts";
import type { InstalledItem } from "@/ui/panels/plugins/installed-rows.ts";
import {
  type PanelHost,
  type PanelIo,
  publishPluginResult,
  setPanelBusy,
} from "@/ui/panels/plugins/panel-actions-support.ts";
import { withData, withInstalled } from "@/ui/panels/plugins/panel-state.ts";

/**
 * The MCP half of the panel's async side: the standalone server list, detail
 * screens, browser OAuth, enable/disable, and reconnects.
 */
export class McpActions {
  private standaloneReloadKey = 0;

  constructor(
    private readonly host: PanelHost,
    private readonly io: PanelIo,
    private readonly onDataChanged: () => void,
  ) {}

  /** Invalidate in-flight loads; the host calls this on unmount. */
  invalidate(): void {
    this.standaloneReloadKey += 1;
  }

  async loadStandaloneMcp(): Promise<void> {
    const key = ++this.standaloneReloadKey;
    const cwd = process.cwd();
    try {
      const [loaded, disabled] = await Promise.all([
        this.io.loadMcpConfig(cwd),
        this.io.loadDisabledMcp(cwd),
      ]);
      if (key !== this.standaloneReloadKey || this.host.isCancelled()) return;
      const items: InstalledItem[] = [];
      for (const name of Object.keys(loaded.config.mcpServers)) {
        if (name.startsWith("plugin:")) continue;
        const enabled = !disabled.has(name);
        const status = enabled ? (mcpServerStatuses([name])[0]?.status ?? "pending") : "disabled";
        items.push({
          type: "mcp",
          id: `mcp:${name}`,
          name,
          scope: loaded.sources[name]?.scope ?? "dynamic",
          status,
          indented: false,
        });
      }
      this.host.setState((state) =>
        withData(state, { disabledMcpNames: disabled, standaloneMcp: items }),
      );
      this.host.requestRender();
    } catch {
      if (key !== this.standaloneReloadKey || this.host.isCancelled()) return;
      this.host.setState((state) => withData(state, { standaloneMcp: [] }));
      this.host.requestRender();
    }
  }

  async openMcpDetail(fullName: string): Promise<void> {
    this.host.setState((state) => withInstalled(state, { mcpMenuIndex: 0 }));
    await this.withMcpRow(fullName, (row) => {
      this.host.setState((state) => withInstalled(state, { detail: { kind: "mcp", server: row } }));
      this.host.requestRender();
    });
  }

  async authenticateMcp(fullName: string): Promise<void> {
    if (fullName.startsWith("plugin:")) {
      await this.authenticatePluginMcp(fullName);
      return;
    }
    await this.withMcpRow(fullName, async (row) => {
      if (!isRemote(row.config)) {
        publishPluginResult(`MCP "${fullName}" does not support browser authentication.`, true);
        return;
      }
      const controller = new AbortController();
      this.host.setAuthAbort(controller);
      setPanelBusy(this.host, `Authorizing ${fullName} — complete in your browser (Esc to cancel)`);
      try {
        const flow = await startOAuthFlow({
          serverName: fullName,
          baseUrl: row.config.url,
          abortSignal: controller.signal,
          ...(row.config.oauthScopes ? { scope: row.config.oauthScopes } : {}),
        });
        const outcome = await flow.done;
        if (this.host.isCancelled()) return;
        if (outcome.kind === "saved") {
          publishPluginResult(`MCP "${fullName}" authorized`);
          this.onDataChanged();
          await this.openMcpDetail(fullName);
        } else {
          publishPluginResult(`MCP "${fullName}" auth failed: ${outcome.reason}`, true);
        }
      } catch (e) {
        if (!this.host.isCancelled()) {
          publishPluginResult(
            `MCP "${fullName}" auth error: ${e instanceof Error ? e.message : String(e)}`,
            true,
          );
        }
      } finally {
        this.host.setAuthAbort(null);
        setPanelBusy(this.host, null);
      }
    });
  }

  async toggleMcpEnabled(fullName: string, currentlyEnabled: boolean): Promise<void> {
    const cwd = process.cwd();
    setPanelBusy(this.host, `${currentlyEnabled ? "Disabling" : "Enabling"} ${fullName}`);
    await this.withMcpRow(fullName, async (row) => {
      await dropClient(row.name, row.config);
    });
    if (this.host.isCancelled()) return;
    await (currentlyEnabled ? disableMcpServer(cwd, fullName) : enableMcpServer(cwd, fullName));
    if (this.host.isCancelled()) return;
    this.host.setState((state) => withData(state, { busy: null }));
    this.onDataChanged();
    const detail = this.host.getState().installed.detail;
    if (detail.kind === "mcp" && detail.server.name === fullName) {
      await this.openMcpDetail(fullName);
    }
  }

  async runMcpDetailOption(server: McpServerRow, optionId: string): Promise<void> {
    if (optionId === "tools") {
      this.host.setState((state) =>
        withInstalled(state, { mcpToolsIndex: 0, detail: { kind: "mcp-tools", server } }),
      );
      this.host.requestRender();
      return;
    }
    if (optionId === "authenticate") {
      await this.authenticateMcp(server.name);
      return;
    }
    if (optionId === "reconnect") {
      await this.reconnectMcp(server);
      return;
    }
    if (optionId === "toggle") {
      await this.toggleMcpEnabled(server.name, server.enabled);
    }
  }

  private async withMcpRow(
    fullName: string,
    fn: (row: McpServerRow) => void | Promise<void>,
  ): Promise<void> {
    const cwd = process.cwd();
    const [loaded, disabled] = await Promise.all([
      this.io.loadMcpConfig(cwd),
      this.io.loadDisabledMcp(cwd),
    ]);
    if (this.host.isCancelled()) return;
    const config = loaded.config.mcpServers[fullName];
    if (!config) return;
    const enabled = !disabled.has(fullName);
    const source = loaded.sources[fullName];
    const inspection = await resolveInspection(fullName, config, enabled, false);
    if (this.host.isCancelled()) return;
    await fn({
      name: fullName,
      config,
      ...(source ? { source } : {}),
      enabled,
      inspection,
    });
  }

  private async authenticatePluginMcp(serverName: string): Promise<void> {
    const config = gatherPluginMcpServers()[serverName];
    if (!config || (config.type !== "http" && config.type !== "sse")) {
      publishPluginResult(`MCP "${serverName}" does not support browser authentication.`, true);
      return;
    }
    const controller = new AbortController();
    this.host.setAuthAbort(controller);
    setPanelBusy(this.host, `Authorizing ${serverName} — complete in your browser (Esc to cancel)`);
    try {
      const flow = await startOAuthFlow({
        serverName,
        baseUrl: config.url,
        abortSignal: controller.signal,
        ...(config.oauthScopes ? { scope: config.oauthScopes } : {}),
      });
      const outcome = await flow.done;
      if (this.host.isCancelled()) return;
      if (outcome.kind === "saved") {
        publishPluginResult(`MCP "${serverName}" authorized`);
        this.onDataChanged();
      } else {
        publishPluginResult(`MCP "${serverName}" auth failed: ${outcome.reason}`, true);
      }
    } catch (e) {
      if (!this.host.isCancelled()) {
        publishPluginResult(
          `MCP "${serverName}" auth error: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
    } finally {
      this.host.setAuthAbort(null);
      setPanelBusy(this.host, null);
    }
  }

  private async reconnectMcp(row: McpServerRow): Promise<void> {
    setPanelBusy(this.host, `Reconnecting to ${row.name}`);
    await dropClient(row.name, row.config);
    const inspection = await resolveInspection(row.name, row.config, row.enabled, false);
    if (this.host.isCancelled()) return;
    this.host.setState((state) =>
      withInstalled(withData(state, { busy: null }), {
        detail: { kind: "mcp", server: { ...row, inspection } },
      }),
    );
    this.onDataChanged();
  }
}
