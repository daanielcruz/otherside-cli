import { addMarketplace } from "@/engine/plugins/marketplace.ts";
import { removeKnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import { UPDATING_MARKETPLACE } from "@/ui/panels/plugins/marketplace-detail.ts";
import {
  type PanelHost,
  publishPluginResult,
  setPanelBusy,
} from "@/ui/panels/plugins/panel-actions-support.ts";
import { withData, withMarketplaces, withNav } from "@/ui/panels/plugins/panel-state.ts";

/** What a finished detail-screen refresh says, counting the plugin versions it moved. */
function updatedMarketplaceLine(bumped: number): string {
  const bump = bumped > 0 ? ` (${bumped} plugin${bumped === 1 ? "" : "s"} bumped)` : "";
  return `Updated 1 marketplace${bump}`;
}

/**
 * The marketplace half of the panel's async side: adds, refreshes, and removals,
 * with the busy line gating a second submission until the first settles.
 */
export class MarketplaceActions {
  constructor(
    private readonly host: PanelHost,
    private readonly onDataChanged: () => void,
  ) {}

  // A pending add/update owns the panel: the busy state both paints the spinner
  // line and refuses a second submission until the first settles.
  async submitAddMarketplace(): Promise<void> {
    if (this.host.getState().data.busy) return;
    const source = (this.host.getState().marketplaces.addInput ?? "").trim();
    if (source.length === 0) return;
    setPanelBusy(this.host, "Adding marketplace to configuration…");
    try {
      const res = await addMarketplace(source, (message) => setPanelBusy(this.host, message));
      if (this.host.isCancelled()) return;
      this.host.setState((state) =>
        withMarketplaces(withData(state, { busy: null }), { addInput: null }),
      );
      if (res.ok) {
        publishPluginResult(`Added marketplace ${res.name} (${res.count} plugins)`);
      } else {
        publishPluginResult(res.error ?? "failed to add marketplace", true);
      }
      this.onDataChanged();
    } finally {
      if (!this.host.isCancelled() && this.host.getState().data.busy) {
        setPanelBusy(this.host, null);
      }
    }
  }

  /**
   * A refresh started from the detail screen stays there: the busy line feeds the
   * screen's own progress block and the outcome lands above its action menu. One
   * started from the roster has no screen to come back to, so it reports through
   * the transcript instead.
   */
  async updateMarketplace(source: string, inDetail: boolean): Promise<void> {
    if (this.host.getState().data.busy) return;
    setPanelBusy(this.host, UPDATING_MARKETPLACE);
    try {
      const res = await addMarketplace(source, (message) => setPanelBusy(this.host, message));
      if (this.host.isCancelled()) return;
      this.host.setState((state) => withData(state, { busy: null }));
      if (!inDetail) {
        publishPluginResult(
          res.ok
            ? `Updated marketplace ${res.name} (${res.count} plugins)`
            : (res.error ?? "failed to update marketplace"),
          !res.ok,
        );
      } else {
        const notice = res.ok
          ? { text: updatedMarketplaceLine(res.bumped ?? 0), isError: false }
          : { text: res.error ?? "failed to update marketplace", isError: true };
        this.host.setState((state) => withMarketplaces(state, { detailNotice: notice }));
      }
      this.onDataChanged();
    } finally {
      if (!this.host.isCancelled() && this.host.getState().data.busy) {
        setPanelBusy(this.host, null);
      }
    }
  }

  removeMarketplace(name: string): void {
    const removed = removeKnownMarketplace(name);
    if (removed) {
      publishPluginResult(`Removed marketplace ${name}`);
      this.host.setState((state) =>
        withNav(withMarketplaces(state, { view: "list" }), {
          selected: Math.max(0, state.nav.selected - 1),
        }),
      );
    } else {
      publishPluginResult(`Marketplace not found: ${name}`, true);
    }
    this.onDataChanged();
  }
}
