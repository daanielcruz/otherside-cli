import type { MarketplaceView, PluginSubtitleCounts, Tab } from "./types.ts";

export const DISCOVER_INPUT_GUIDE =
  "Type to search · Space to toggle · Enter to view · Esc to go back";

export const TAB_LABELS: Record<Tab, string> = {
  discover: "Discover",
  installed: "Installed",
  marketplaces: "Marketplaces",
  errors: "Errors",
};

/** Tab label with the live error count on the Errors tab (e.g. `Errors (2)`). */
export function tabLabelFor(tab: Tab, errorCount: number): string {
  if (tab === "errors" && errorCount > 0) return `${TAB_LABELS.errors} (${errorCount})`;
  return TAB_LABELS[tab];
}

export interface PanelSubtitleParts {
  /** Bold heading segment. */
  heading: string;
  /** Muted trailing segment (e.g. ` (1/255)`), rendered after the heading. */
  counter?: string;
}

export function subtitleFor(tab: Tab, counts: PluginSubtitleCounts): PanelSubtitleParts {
  if (tab === "discover") return { heading: "Discover plugins" };
  if (tab === "installed") return { heading: `${counts.installed} installed` };
  if (tab === "marketplaces") return { heading: "Manage marketplaces" };
  return { heading: "Errors" };
}

export const INSTALLED_DETAILS_HINTS: [string, string][] = [
  ["ctrl+p", "to navigate"],
  ["Enter", "to select"],
  ["Esc", "to go back"],
];

export function footerHintsFor(tab: Tab, marketplaceView: MarketplaceView): [string, string][] {
  if (tab === "installed") {
    return [
      ["Space", "toggle"],
      ["Enter", "view"],
      ["f", "favorite"],
      ["PgUp/PgDn", "page"],
      ["←/→", "tabs"],
      ["Esc", "close"],
    ];
  }
  if (tab === "discover") return [];
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
