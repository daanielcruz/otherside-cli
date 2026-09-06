import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { formatHint, hintFor, hintLines, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import type { FooterPanelSpec, PanelSearch } from "@/ui/chrome/string-view-panel.ts";
import { type PanelState, searchEngaged } from "@/ui/panels/plugins/panel-state.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { type MarketplaceView, TABS, type Tab } from "./types.ts";

/** Columns the panel body is inset from each edge. */
export const CONTENT_PAD = 2;
/** Label column of a `label · value` row in a drill-down. */
export const DETAIL_ROW_WIDTH = 18;
/** Label column of a selectable action row. */
export const MENU_ROW_WIDTH = 24;

/** Body of one drill-down view, with the chrome it asks the panel to frame it in. */
export interface PanelDetailView {
  body: string[];
  footerHints: [string, string][];
  subtitle?: string;
  /** The view paints the in-flight work itself, so the frame keeps its busy line out. */
  ownsBusy?: boolean;
}

export interface PluginFooterInput {
  state: PanelState;
  pluginErrorCount: number;
  maxRows: number;
  body: string[];
  footerHints?: [string, string][];
  search?: PanelSearch;
  searchMarginTop?: number;
  subtitle?: string;
  subtitleSuffix?: string;
  flushTop?: boolean;
  suppressBusy?: boolean;
}

/** Complete frame specification used for both body budgeting and final rendering. */
export function pluginFooterSpec(input: PluginFooterInput): FooterPanelSpec {
  const { state } = input;
  const prefix: string[] = [];
  if (state.data.commandResult) {
    prefix.push(
      renderTextWithStyles(`${Glyph.check} ${state.data.commandResult}`, { color: Color.success }),
      "",
    );
  }
  if (state.data.busy && input.suppressBusy !== true) {
    prefix.push(renderTextWithStyles(`${Glyph.bullet} ${state.data.busy}`, { color: Color.muted }));
  }

  const spec: FooterPanelSpec = {
    command: "/plugins",
    title: "Plugins",
    tabs: TABS.map((tab) => ({ label: tabLabelFor(tab, input.pluginErrorCount) })),
    activeTab: TABS.indexOf(state.nav.tab),
    // An empty focused search keeps tab navigation active until it holds text.
    headerFocused: !searchEngaged(state),
    maxRows: input.maxRows,
    body: [...prefix, ...input.body],
    flushTop: input.flushTop ?? true,
  };
  if (input.subtitle !== undefined) spec.subtitle = input.subtitle;
  if (input.subtitleSuffix !== undefined) spec.subtitleSuffix = input.subtitleSuffix;
  if (input.search !== undefined) spec.search = input.search;
  if (input.searchMarginTop !== undefined) spec.searchMarginTop = input.searchMarginTop;
  if (input.footerHints !== undefined && input.footerHints.length > 0) {
    spec.footerHints = input.footerHints;
  }
  return spec;
}

export interface PluginListFooterInput {
  state: PanelState;
  pluginErrorCount: number;
  maxRows: number;
  body: string[];
  discoverCounter?: string;
}

/** List-surface frame shape shared by budgeting and rendering. */
export function pluginListFooterSpec(input: PluginListFooterInput): FooterPanelSpec {
  const common = {
    state: input.state,
    pluginErrorCount: input.pluginErrorCount,
    maxRows: input.maxRows,
    body: input.body,
  };
  if (input.state.nav.tab === "discover") {
    return pluginFooterSpec({
      ...common,
      // Browsing one marketplace is a catalogue of that marketplace, not the
      // cross-marketplace recommendation feed Discover otherwise shows.
      subtitle:
        input.state.discover.marketplaceFilter === null ? "Discover plugins" : "Install Plugins",
      ...(input.discoverCounter === undefined
        ? {}
        : { subtitleSuffix: ` ${input.discoverCounter}` }),
      search: {
        query: input.state.search.query,
        placeholder: "Search…",
        focused: input.state.search.focused,
        ...(input.state.search.cursorOffset !== undefined
          ? { cursorOffset: input.state.search.cursorOffset }
          : {}),
      },
    });
  }
  if (input.state.nav.tab === "installed") {
    return pluginFooterSpec({
      ...common,
      searchMarginTop: 1,
      search: {
        query: input.state.search.query,
        placeholder: "Search…",
        focused: input.state.search.focused,
        ...(input.state.search.cursorOffset !== undefined
          ? { cursorOffset: input.state.search.cursorOffset }
          : {}),
      },
    });
  }
  if (input.state.nav.tab === "marketplaces") {
    return pluginFooterSpec({
      ...common,
      subtitle: "Manage marketplaces",
      footerHints: footerHintsFor("marketplaces", input.state.marketplaces.view),
    });
  }
  return pluginFooterSpec({
    ...common,
    flushTop: false,
    footerHints: footerHintsFor("errors", input.state.marketplaces.view),
  });
}

/** Guide hints under the discover list, phrased by the hint SoT. */
const LIST_GUIDE_HINTS: readonly PanelHint[] = [
  hintFor("typeToSearch"),
  hintFor("spaceToggle"),
  hintFor("enterView"),
  hintFor("back"),
];

/** The installed list adds the favorite shortcut between toggle and view. */
const INSTALLED_GUIDE_HINTS: readonly PanelHint[] = [
  hintFor("typeToSearch"),
  hintFor("spaceToggle"),
  hintFor("favorite"),
  hintFor("enterView"),
  hintFor("back"),
];

const GUIDE_STYLE = { color: Color.muted, italic: true } as const;

/** Wrapped hint lines in the guide style; `boldPrefix` renders bold where a line opens with it. */
function styledGuideLines(
  hints: readonly PanelHint[],
  contentWidth: number,
  boldPrefix?: string,
): string[] {
  return hintLines(hints, contentWidth).map((line) =>
    boldPrefix !== undefined && line.startsWith(boldPrefix)
      ? renderTextWithStyles(boldPrefix, { ...GUIDE_STYLE, bold: true }) +
        renderTextWithStyles(line.slice(boldPrefix.length), GUIDE_STYLE)
      : renderTextWithStyles(line, GUIDE_STYLE),
  );
}

/** Muted guide lines under the installed list, wrapped to the content width. */
export function installedInputGuideLines(contentWidth: number): string[] {
  return styledGuideLines(INSTALLED_GUIDE_HINTS, contentWidth);
}

/**
 * Muted guide lines under the discover list. A marked selection prepends a bold
 * install hint as the call to action for the pending batch.
 */
export function discoverInputGuideLines(
  contentWidth: number,
  hasMarkedSelection: boolean,
): string[] {
  if (!hasMarkedSelection) return styledGuideLines(LIST_GUIDE_HINTS, contentWidth);
  const installHint = hintFor("install");
  return styledGuideLines(
    [installHint, ...LIST_GUIDE_HINTS],
    contentWidth,
    formatHint(installHint),
  );
}

export const MCP_DETAILS_HINTS: [string, string][] = [
  ["↑/↓", "to navigate"],
  ["Enter", "to select"],
  ["Esc", "to back"],
];

export const SKILL_DETAILS_HINTS: [string, string][] = [
  ["Enter", "to set state"],
  ["Esc", "to go back"],
];

export const FAILED_DETAILS_HINTS: [string, string][] = [["Esc", "to go back"]];

export const MCP_TOOL_HINTS: [string, string][] = [["Esc", "to go back"]];

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

export const INSTALLED_DETAILS_HINTS: [string, string][] = [
  ["ctrl+p", "to navigate"],
  ["Enter", "to select"],
  ["Esc", "to go back"],
];

/**
 * Footer hints for the tabs that carry them; the discover and installed lists
 * phrase their guidance through the input-guide lines instead.
 */
export function footerHintsFor(tab: Tab, marketplaceView: MarketplaceView): [string, string][] {
  if (tab === "marketplaces") {
    if (marketplaceView === "confirm-remove") {
      return [
        ["y", "remove"],
        ["n/Esc", "cancel"],
      ];
    }
    if (marketplaceView === "details") {
      return [
        ["Enter", "to select"],
        ["Esc", "to go back"],
      ];
    }
    return [
      ["Enter", "to select"],
      ["u", "to update"],
      ["d", "to remove"],
      ["Esc", "to go back"],
    ];
  }
  return [["Esc", "to go back"]];
}
