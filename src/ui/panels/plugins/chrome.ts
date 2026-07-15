import type { MarketplaceView, PluginSubtitleCounts, Tab } from "./types.ts";

export const TAB_LABELS: Record<Tab, string> = {
  discover: "Discover",
  installed: "Installed",
  marketplaces: "Marketplaces",
  errors: "Errors",
};

export function subtitleFor(tab: Tab, counts: PluginSubtitleCounts): string {
  if (tab === "discover") {
    return `Discover plugins (${selectedOrdinal(counts.selected, counts.discover)}/${counts.discover})`;
  }
  if (tab === "installed") return `${counts.installed} installed`;
  if (tab === "marketplaces") return `${counts.marketplaces} marketplaces`;
  return "Errors";
}

function selectedOrdinal(selected: number, count: number): number {
  if (count === 0) return 0;
  return selected + 1;
}

export function footerHintsFor(tab: Tab, marketplaceView: MarketplaceView): [string, string][] {
  if (tab === "installed") {
    return [
      ["Space/Enter", "toggle"],
      ["f", "favorite"],
      ["PgUp/PgDn", "page"],
      ["←/→", "tabs"],
      ["Esc", "close"],
    ];
  }
  if (tab === "discover") {
    return [
      ["Space", "toggle"],
      ["i/Enter", "install"],
      ["PgUp/PgDn", "page"],
      ["←/→", "tabs"],
      ["Esc", "close"],
    ];
  }
  if (tab === "marketplaces") {
    if (marketplaceView === "confirm-remove") {
      return [
        ["y", "remove"],
        ["n/Esc", "cancel"],
      ];
    }
    if (marketplaceView === "details") {
      return [
        ["Enter", "select"],
        ["u", "update"],
        ["d", "remove"],
        ["Esc", "back"],
      ];
    }
    return [
      ["Enter", "select"],
      ["u", "update"],
      ["d", "remove"],
      ["PgUp/PgDn", "page"],
      ["Esc", "close"],
    ];
  }
  return [
    ["←/→", "tabs"],
    ["Esc", "close"],
  ];
}
