import { requiredByWarning } from "@/engine/plugins/dependencies.ts";
import { refreshOfficialCatalog } from "@/engine/plugins/official-catalog.ts";
import { loadDisabledMcpServers, loadEffectiveMcpConfigWithSources } from "@/kernel/mcp/config.ts";
import { type PanelState, withData } from "@/ui/panels/plugins/panel-state.ts";
import { publishPanelTranscriptLine } from "@/ui/panels/transcript-feedback.ts";

/** How the async side reaches the panel it works for. */
export interface PanelHost {
  getState(): PanelState;
  setState(next: (state: PanelState) => PanelState): void;
  requestRender(): void;
  isCancelled(): boolean;
  close(): void;
  setAuthAbort(controller: AbortController | null): void;
}

/**
 * The engine reads mount and tab entry perform. A test rig substitutes these to
 * keep panel construction free of real-config reads.
 */
export interface PanelIo {
  refreshCatalog(): Promise<unknown>;
  loadMcpConfig(cwd: string): ReturnType<typeof loadEffectiveMcpConfigWithSources>;
  loadDisabledMcp(cwd: string): ReturnType<typeof loadDisabledMcpServers>;
}

export const LIVE_PANEL_IO: PanelIo = {
  refreshCatalog: () => refreshOfficialCatalog(),
  loadMcpConfig: (cwd) => loadEffectiveMcpConfigWithSources(cwd),
  loadDisabledMcp: (cwd) => loadDisabledMcpServers(cwd),
};

export function publishPluginResult(text: string, isError = false): void {
  publishPanelTranscriptLine("/plugins", text, isError);
}

export function withReloadHint(message: string, ok: boolean): string {
  if (!ok || message.includes("/reload")) return message;
  const separator = message.endsWith(".") || message.endsWith("!") ? " " : ". ";
  return `${message}${separator}Run /reload to activate.`;
}

/**
 * How an in-panel operation reports itself: past-tense verb, the plugin it acted
 * on, whatever still depends on it, and the command that makes it take effect.
 * The frame supplies the green tick.
 */
export function operationLine(
  verb: string,
  name: string,
  dependents: readonly string[] = [],
): string {
  return withReloadHint(`${verb} ${name}${requiredByWarning(dependents)}.`, true);
}

/** The busy line both paints the spinner and gates re-entry while an op settles. */
export function setPanelBusy(host: PanelHost, busy: string | null): void {
  host.setState((state) => withData(state, { busy }));
  host.requestRender();
}
