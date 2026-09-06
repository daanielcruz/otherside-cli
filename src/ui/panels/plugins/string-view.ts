import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { registerFrameClient } from "@/ui/chrome/progress/frame-clients.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import { consumePendingPluginCommandResult } from "@/ui/panels/plugins/command-result.ts";
import { loadFavoriteNames } from "@/ui/panels/plugins/favorites.ts";
import { LIVE_PANEL_IO, PanelActions, type PanelIo } from "@/ui/panels/plugins/panel-actions.ts";
import { panelKeyStep } from "@/ui/panels/plugins/panel-keys.ts";
import type { PanelModelReader } from "@/ui/panels/plugins/panel-keys-support.ts";
import {
  buildPanelModel,
  clampedSelection,
  type PanelViewport,
} from "@/ui/panels/plugins/panel-model.ts";
import { renderAddMarketplace, renderPanel } from "@/ui/panels/plugins/panel-render.ts";
import { initialPanelState, type PanelState } from "@/ui/panels/plugins/panel-state.ts";
import type { PluginsOverlayProps } from "@/ui/panels/plugins/types.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

/**
 * Plugins manager on the string model. Tabbed Discover / Installed / Marketplaces /
 * Errors surface with search, multi-select install, installed drill-downs (plugin /
 * MCP / skill / failed), marketplace add-update-remove, and command-result feedback.
 *
 * The class is only the host: state lives in one explicit record (`panel-state`),
 * keys resolve as pure steps returning state + effects (`panel-keys`), the model
 * is a pure projection (`panel-model`), rendering is stateless (`panel-render`),
 * and every async effect runs in `panel-actions`.
 */
class PluginsPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cancelled = false;
  private authAbort: AbortController | null = null;
  private unregisterFrameClient: (() => void) | undefined;
  private state: PanelState;
  private viewport: PanelViewport = { width: 80, terminalRows: FALLBACK_TERMINAL_ROWS };
  private readonly actions: PanelActions;

  constructor(
    private readonly close: () => void,
    props?: unknown,
    io: PanelIo = LIVE_PANEL_IO,
  ) {
    const overlayProps = props as PluginsOverlayProps | undefined;
    const commandResult =
      overlayProps?.commandResult !== undefined
        ? (overlayProps.commandResult ?? null)
        : consumePendingPluginCommandResult();
    this.state = initialPanelState({ commandResult, favorites: loadFavoriteNames() });
    this.actions = new PanelActions(
      {
        getState: () => this.state,
        setState: (next) => {
          this.state = next(this.state);
        },
        requestRender: () => this.ctx?.requestRender(),
        isCancelled: () => this.cancelled,
        close: () => this.close(),
        setAuthAbort: (controller) => {
          this.authAbort = controller;
        },
      },
      io,
    );
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    this.unregisterFrameClient = registerFrameClient(() => this.state.data.busy !== null);
    void this.actions.refreshCatalog();
    void this.actions.loadStandaloneMcp();
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.actions.invalidate();
    this.authAbort?.abort();
    this.authAbort = null;
    this.unregisterFrameClient?.();
    this.unregisterFrameClient = undefined;
    this.ctx = undefined;
  }

  /** Builds the model for a state and keeps what the read settled (clamp, windows). */
  private readonly readModel: PanelModelReader = (state) => {
    const viewport = {
      ...this.viewport,
      terminalRows: this.ctx?.terminalRows?.() ?? this.viewport.terminalRows,
    };
    const built = buildPanelModel(state, viewport);
    const settled = clampedSelection(built.next, built.model);
    this.state = settled;
    return { state: settled, model: built.model };
  };

  render(width: number): string[] {
    const terminalRows = this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
    this.viewport = { width, terminalRows };
    if (this.state.marketplaces.addInput !== null) {
      return renderAddMarketplace(this.state, width);
    }
    const io = { maxRows: () => terminalRows };
    const { state, model } = this.readModel(this.state);
    return renderPanel(state, model, width, io);
  }

  handleKey(key: KeyEventData): void {
    // A busy panel swallows keys; Esc aborts an in-flight browser auth.
    if (this.state.data.busy && this.authAbort) {
      // Stops an authorization in flight, which is not a panel leaving.
      if (key.name === "escape") this.authAbort.abort();
      return;
    }
    if (this.state.data.busy) return;

    const outcome = panelKeyStep(this.state, key, this.readModel);
    if (outcome === undefined) return;
    this.state = outcome.state;
    for (const effect of outcome.effects ?? []) this.actions.run(effect);
    this.ctx?.requestRender();
  }
}

export function createPluginsPanel(
  close: () => void,
  props?: unknown,
  io?: PanelIo,
): StringViewPanel {
  return new PluginsPanel(close, props, io);
}
