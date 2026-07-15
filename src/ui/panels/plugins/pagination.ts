import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { MarketplacePluginEntry } from "@/engine/plugins/marketplace.ts";
import type { KnownMarketplace } from "@/engine/plugins/marketplaces-store.ts";
import type { McpServerStatusEntry } from "@/kernel/mcp/client/registry.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";

const PANEL_COMMAND_ROWS = 2;
const PANEL_RULE_ROWS = 1;
const PANEL_HEADER_ROWS = 1;
const PANEL_SUBTITLE_ROWS = 2;
const PANEL_SEARCH_ROWS = 4;
const PANEL_CONTENT_MARGIN_ROWS = 1;
const PANEL_FOOTER_ROWS = 2;
const PANEL_BODY_MARGIN_ROWS = 1;
const PANEL_OVERFLOW_ROWS = 2;
const PANEL_MIN_BODY_ROWS = 1;

export type PluginsPageRow =
  | { kind: "heading"; id: string; label: string; height: 1 }
  | {
      kind: "installed";
      id: string;
      itemIndex: number;
      plugin: LoadedPlugin;
      height: 1;
    }
  | {
      kind: "mcp";
      id: string;
      itemIndex: number;
      server: McpServerStatusEntry;
      height: 1;
    }
  | { kind: "marketplace-heading"; id: string; label: string; height: 1 }
  | {
      kind: "marketplace";
      id: string;
      itemIndex: number;
      marketplace: KnownMarketplace;
      pluginCount: number;
      height: 3;
    }
  | {
      kind: "add-marketplace";
      id: "add-marketplace";
      itemIndex: 0;
      height: 2;
    }
  | {
      kind: "discover";
      id: string;
      itemIndex: number;
      marketplace: string;
      entry: MarketplacePluginEntry;
      height: 2;
    };

export interface PluginsPageWindow {
  rows: PluginsPageRow[];
  aboveItems: number;
  belowItems: number;
  firstItem: number;
  lastItem: number;
  itemCapacity: number;
}

export interface PluginsChromeState {
  searchVisible: boolean;
  commandResult: boolean;
  busy: boolean;
  footerRows?: number;
}

export function pluginsBodyHeight(terminalRows: number, chrome: PluginsChromeState): number {
  let overhead =
    PANEL_COMMAND_ROWS +
    PANEL_RULE_ROWS +
    PANEL_HEADER_ROWS +
    PANEL_SUBTITLE_ROWS +
    PANEL_CONTENT_MARGIN_ROWS +
    PANEL_FOOTER_ROWS +
    PANEL_BODY_MARGIN_ROWS +
    Math.max(0, (chrome.footerRows ?? 1) - 1);
  if (chrome.searchVisible) overhead += PANEL_SEARCH_ROWS;
  if (chrome.commandResult) overhead += 2;
  if (chrome.busy) overhead += 1;
  return Math.max(PANEL_MIN_BODY_ROWS, Math.floor(terminalRows) - overhead);
}

export function pluginsFooterRows(
  columns: number,
  footerHints: readonly (readonly [string, string])[],
): number {
  const available = Math.max(1, Math.floor(columns) - 6);
  let rows = 1;
  let used = 0;
  for (const [key, label] of footerHints) {
    const width = stringWidth(`${key} ${label}${used === 0 ? "" : " ·"}`);
    if (used > 0 && used + width > available) {
      rows += 1;
      used = width;
    } else {
      used += width;
    }
  }
  return rows;
}

export function pluginsPageRows(terminalRows: number, chrome: PluginsChromeState): number {
  return Math.max(
    PANEL_MIN_BODY_ROWS,
    pluginsBodyHeight(terminalRows, chrome) - PANEL_OVERFLOW_ROWS,
  );
}

export function clampPluginsIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

export function selectedInstalledPlugin(
  installed: readonly LoadedPlugin[],
  selected: number,
): LoadedPlugin | undefined {
  return installed[selected];
}

export function pagePluginsIndex(
  index: number,
  count: number,
  direction: 1 | -1,
  itemCapacity: number,
): number {
  return clampPluginsIndex(index + direction * Math.max(1, itemCapacity), count);
}

export function pluginsPageWindow(
  rows: readonly PluginsPageRow[],
  selected: number,
  height: number,
): PluginsPageWindow {
  const selectable = rows.filter(isSelectableRow);
  if (selectable.length === 0) {
    return {
      rows: [],
      aboveItems: 0,
      belowItems: 0,
      firstItem: 0,
      lastItem: -1,
      itemCapacity: 1,
    };
  }

  const selectedItem = clampPluginsIndex(selected, selectable.length);
  const budget = Math.max(1, Math.floor(height));
  const pages = paginateRows(rows, budget);
  const currentPage =
    pages.find((page) =>
      page.some((row) => isSelectableRow(row) && row.itemIndex === selectedItem),
    ) ??
    pages[0] ??
    [];
  const visibleItems = currentPage.filter(isSelectableRow).map((row) => row.itemIndex);
  const firstItem = visibleItems[0] ?? selectedItem;
  const lastItem = visibleItems.at(-1) ?? selectedItem;

  return {
    rows: currentPage,
    aboveItems: firstItem,
    belowItems: Math.max(0, selectable.length - lastItem - 1),
    firstItem,
    lastItem,
    itemCapacity: Math.max(1, visibleItems.length),
  };
}

function paginateRows(rows: readonly PluginsPageRow[], height: number): PluginsPageRow[][] {
  const pages: PluginsPageRow[][] = [];
  let page: PluginsPageRow[] = [];
  let used = 0;

  function flush(): void {
    if (page.length === 0) return;
    pages.push(page);
    page = [];
    used = 0;
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const next = rows[index + 1];
    const keepWithNext = isHeadingRow(row) && next !== undefined ? next.height : 0;
    if (page.length > 0 && used + row.height + keepWithNext > height) flush();
    if (page.length > 0 && used + row.height > height) flush();
    page.push(row);
    used += row.height;
  }
  flush();
  return pages;
}

export function isSelectableRow(
  row: PluginsPageRow,
): row is Extract<PluginsPageRow, { itemIndex: number }> {
  return "itemIndex" in row;
}

function isHeadingRow(
  row: PluginsPageRow,
): row is Extract<PluginsPageRow, { kind: "heading" | "marketplace-heading" }> {
  return row.kind === "heading" || row.kind === "marketplace-heading";
}
