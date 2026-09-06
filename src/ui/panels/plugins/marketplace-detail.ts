import { listMarketplacePlugins } from "@/engine/plugins/marketplace.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import {
  footerHintsFor,
  MENU_ROW_WIDTH,
  type PanelDetailView,
} from "@/ui/panels/plugins/chrome.ts";
import type { MarketplaceView } from "@/ui/panels/plugins/types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** Headline the detail screen holds while a refresh runs; also the busy line's seed. */
export const UPDATING_MARKETPLACE = "Updating marketplace…";

export function formatMarketplaceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

/**
 * One marketplace: what it carries, which of its plugins are already here, and the three
 * things that can be done to it. Removal asks first, on its own screen, because it takes
 * the whole catalogue away.
 */
export function marketplaceDetailView(input: {
  marketplace: KnownMarketplace | undefined;
  installedPlugins: readonly { name: string; description?: string }[];
  view: MarketplaceView;
  selection: number;
  contentWidth: number;
  busy: string | null;
  notice: { text: string; isError: boolean } | null;
}): PanelDetailView {
  const { marketplace, installedPlugins, view, selection, contentWidth, busy, notice } = input;
  if (!marketplace) {
    return {
      body: [renderTextWithStyles("Marketplace not found", { color: Color.muted })],
      footerHints: footerHintsFor("marketplaces", view),
    };
  }

  if (view === "confirm-remove") {
    return {
      body: [
        renderTextWithStyles(`Remove marketplace ${marketplace.name}?`, {
          color: Color.warning,
          bold: true,
        }),
        "",
        renderTextWithStyles("This removes the marketplace from the configured list.", {
          color: Color.warning,
        }),
      ],
      footerHints: footerHintsFor("marketplaces", "confirm-remove"),
    };
  }

  const pluginCount = listMarketplacePlugins(marketplace.name).length;
  const body: string[] = [];
  body.push(renderTextWithStyles(marketplace.name, { bold: true }));
  body.push(renderTextWithStyles(marketplace.source, { color: Color.muted }));
  body.push("");
  body.push(
    renderTextWithStyles(`${pluginCount} available plugin${pluginCount === 1 ? "" : "s"}`, {
      color: Color.text,
    }),
  );
  if (installedPlugins.length > 0) {
    body.push("");
    body.push(
      renderTextWithStyles(`Installed plugins (${installedPlugins.length}):`, { bold: true }),
    );
    for (const plugin of installedPlugins) {
      body.push(
        renderTextWithStyles(` ${Glyph.bulletFilled} ${plugin.name}`, { color: Color.text }),
      );
      if (plugin.description) {
        body.push(renderTextWithStyles(`   ${plugin.description}`, { color: Color.muted }));
      }
    }
  }

  // An update owns the screen while it runs: the headline names the work, the
  // engine's progress line sits under it, and the action menu stays away until
  // the refresh settles.
  if (busy !== null) {
    body.push("");
    body.push(renderTextWithStyles(UPDATING_MARKETPLACE, { color: Color.brand }));
    if (busy !== UPDATING_MARKETPLACE) {
      body.push(renderTextWithStyles(busy, { color: Color.muted }));
    }
    body.push("");
    body.push(renderTextWithStyles("Please wait…", { color: Color.muted, italic: true }));
    return { body, footerHints: [], ownsBusy: true };
  }

  if (notice) {
    body.push("");
    body.push(
      renderTextWithStyles(`${notice.isError ? Glyph.cross : Glyph.check} ${notice.text}`, {
        color: notice.isError ? Color.error : Color.brand,
      }),
    );
  }

  body.push("");
  const actions = [
    `Browse plugins (${pluginCount})`,
    `Update marketplace (last updated ${formatMarketplaceDate(marketplace.lastUpdated)})`,
    "Remove marketplace",
  ];
  for (let i = 0; i < actions.length; i++) {
    body.push(
      renderPanelRowLine(
        { label: actions[i]!, selected: i === selection },
        contentWidth,
        MENU_ROW_WIDTH,
      ),
    );
  }
  return { body, footerHints: footerHintsFor("marketplaces", "details") };
}
