import { listPluginInstallations } from "@/engine/plugins/installations.ts";
import { listMarketplacePlugins, OFFICIAL_MARKETPLACE_NAME } from "@/engine/plugins/marketplace.ts";
import { getSnapshot } from "@/engine/plugins/state.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { spinnerFrame } from "@/ui/chrome/progress/index.ts";
import {
  type FooterPanelSpec,
  type PanelPickerRowSpec,
  renderFooterPanel,
  renderPanelPickerRowLines,
} from "@/ui/chrome/string-view-panel.ts";
import {
  CONTENT_PAD,
  discoverInputGuideLines,
  installedInputGuideLines,
  type PanelDetailView,
  pluginFooterSpec,
  pluginListFooterSpec,
} from "@/ui/panels/plugins/chrome.ts";
import {
  discoverDetailView,
  formatInstallCount,
  truncateDiscoverDescription,
} from "@/ui/panels/plugins/discover-detail.ts";
import { renderInstalledRowLines } from "@/ui/panels/plugins/installed-rows.ts";
import {
  formatMarketplaceDate,
  marketplaceDetailView,
} from "@/ui/panels/plugins/marketplace-detail.ts";
import { mcpDetailView, mcpToolDetailView, mcpToolsView } from "@/ui/panels/plugins/mcp-detail.ts";
import type { PanelModel } from "@/ui/panels/plugins/panel-model.ts";
import type { PanelState } from "@/ui/panels/plugins/panel-state.ts";
import {
  failedPluginDetailView,
  installedDetailActions,
  pluginDetailView,
} from "@/ui/panels/plugins/plugin-detail.ts";
import { skillDetailView } from "@/ui/panels/plugins/skill-detail.ts";
import type { DiscoverItem } from "@/ui/panels/plugins/types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const TEARDROP_ASTERISK = "✻";
const TEARDROP_ASTERISK_COLOR = "ansi256(174)";

/** Geometry and chrome the renderers read from the host component. */
export interface RenderIo {
  maxRows(): number;
}

/** Body width once the panel's own inset is taken off both edges. */
export function contentWidthFor(width: number): number {
  return Math.max(1, width - CONTENT_PAD * 2);
}

/** Hidden-item marker row from the shared window policy, rendered dim. */
function dimMarkerLine(marker: string): string {
  return renderTextWithStyles(marker, { dim: true });
}

function marketplaceLabelLine(name: string, selected: boolean): string {
  const marker = renderTextWithStyles(
    selected ? Glyph.chevron + Glyph.bulletFilled : `  ${Glyph.bulletFilled}`,
    selected ? { color: Color.panelAccent } : {},
  );
  const badge =
    name === OFFICIAL_MARKETPLACE_NAME
      ? renderTextWithStyles(`${TEARDROP_ASTERISK} `, {
          bold: true,
          color: TEARDROP_ASTERISK_COLOR,
        })
      : "";
  const trailingBadge =
    name === OFFICIAL_MARKETPLACE_NAME
      ? renderTextWithStyles(` ${TEARDROP_ASTERISK}`, {
          bold: true,
          color: TEARDROP_ASTERISK_COLOR,
        })
      : "";
  return marker + " " + badge + renderTextWithStyles(name, { bold: true }) + trailingBadge;
}

function baseFooter(
  state: PanelState,
  io: RenderIo,
  body: string[],
  width: number,
  opts: {
    footerHints?: [string, string][];
    search?: { query: string; placeholder: string; focused: boolean };
    searchMarginTop?: number;
    subtitle?: string;
    flushTop?: boolean;
    pluginErrorCount?: number;
    suppressBusy?: boolean;
  } = {},
): string[] {
  const spec = pluginFooterSpec({
    state,
    pluginErrorCount: opts.pluginErrorCount ?? getSnapshot().errors.length,
    maxRows: io.maxRows(),
    body,
    flushTop: opts.flushTop ?? true,
    ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    ...(opts.search !== undefined ? { search: opts.search } : {}),
    ...(opts.searchMarginTop !== undefined ? { searchMarginTop: opts.searchMarginTop } : {}),
    ...(opts.footerHints !== undefined ? { footerHints: opts.footerHints } : {}),
    ...(opts.suppressBusy === true ? { suppressBusy: true } : {}),
  });
  return renderFooterPanel(spec, width);
}

function listFooter(input: {
  state: PanelState;
  io: RenderIo;
  body: string[];
  width: number;
  pluginErrorCount: number;
  discoverCounter?: string;
}): string[] {
  return renderFooterPanel(
    pluginListFooterSpec({
      state: input.state,
      pluginErrorCount: input.pluginErrorCount,
      maxRows: input.io.maxRows(),
      body: input.body,
      ...(input.discoverCounter === undefined ? {} : { discoverCounter: input.discoverCounter }),
    }),
    input.width,
  );
}

function framed(state: PanelState, io: RenderIo, view: PanelDetailView, width: number): string[] {
  // Detail views carry no search box, so they buy their own margin row under
  // the tab header — the same one-row gap the list views get from the search.
  return baseFooter(state, io, view.body, width, {
    footerHints: view.footerHints,
    flushTop: false,
    ...(view.subtitle !== undefined ? { subtitle: view.subtitle } : {}),
    ...(view.ownsBusy === true ? { suppressBusy: true } : {}),
  });
}

export function renderPanel(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  const tab = state.nav.tab;
  if (tab === "installed" && state.installed.detail.kind !== "list") {
    return renderInstalledDetail(state, model, width, io);
  }
  if (tab === "discover" && state.discover.details) {
    return renderDiscoverDetails(state, io, state.discover.details, width);
  }
  if (tab === "marketplaces" && state.marketplaces.view !== "list") {
    return renderMarketplaceSubView(state, model, width, io);
  }
  if (tab === "errors") return renderErrors(state, io, width);
  if (tab === "installed") return renderInstalledList(state, model, width, io);
  if (tab === "marketplaces") return renderMarketplacesList(state, model, width, io);
  return renderDiscoverList(state, model, width, io);
}

/** What an empty browse says, phrased for the surface that came up short. */
function discoverEmptyLine(query: string, browseScope: string | null): string {
  if (query.length > 0) return "No plugins match your search.";
  if (browseScope !== null) return "This marketplace carries no plugins.";
  return "No plugins to discover. Add a marketplace first.";
}

/**
 * One catalogue row: the mark and the name carry the row's state, everything
 * that qualifies it trails behind them dim. A marketplace browse drops the
 * redundant marketplace suffix and ticks what is already installed in green;
 * Discover keeps the multi-select radio and names where each entry came from.
 */
function discoverRowSpec(
  state: PanelState,
  item: DiscoverItem,
  scoped: boolean,
): Pick<PanelPickerRowSpec, "label" | "labelMeta" | "description" | "labelColor"> {
  const marked = state.discover.marked.has(`${item.marketplace}:${item.entry.name}`);
  const mark = item.installed ? Glyph.check : marked ? Glyph.radioOn : Glyph.circleLarge;
  const community =
    item.entry.communityManaged || item.entry.tags?.includes("community-managed")
      ? " [Community Managed]"
      : "";
  const installs =
    item.entry.installCount !== undefined
      ? ` · ${formatInstallCount(item.entry.installCount)} installs`
      : "";
  const origin = scoped ? "" : ` · ${item.marketplace}`;
  const installedNote = item.installed ? " (installed)" : "";
  return {
    label: `${mark} ${item.entry.name}`,
    labelMeta: `${origin}${community}${installs}${installedNote}`,
    ...(item.entry.description
      ? { description: truncateDiscoverDescription(item.entry.description) }
      : {}),
    ...(item.installed ? { labelColor: Color.success } : {}),
  };
}

function renderDiscoverList(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  const contentWidth = contentWidthFor(width);
  const body: string[] = [];
  const selected = state.search.focused ? -1 : model.selectedIndex;

  const window = model.browseWindow;
  const browseScope = state.discover.marketplaceFilter;
  if (model.discoverFiltered.length === 0) {
    body.push(
      renderTextWithStyles(discoverEmptyLine(model.qlower, browseScope), { color: Color.muted }),
    );
  } else {
    if (window.markerAbove !== undefined) body.push(dimMarkerLine(window.markerAbove));
    for (let itemIndex = window.from; itemIndex < window.to; itemIndex++) {
      const item = model.discoverFiltered[itemIndex]!;
      // A blank row separates entries; the last visible one sits flush against
      // whatever follows (overflow marker or the guide gap).
      const isLastVisible = itemIndex === window.to - 1;
      for (const line of renderPanelPickerRowLines(
        {
          ...discoverRowSpec(state, item, browseScope !== null),
          selected: selected === itemIndex,
          rows: isLastVisible ? 2 : 3,
          descriptionIndent: 4,
        },
        contentWidth,
      )) {
        body.push(line);
      }
    }
    if (window.markerBelow !== undefined) body.push(dimMarkerLine(window.markerBelow));
  }

  body.push("");
  for (const line of discoverInputGuideLines(contentWidth, state.discover.marked.size > 0)) {
    body.push(line);
  }

  return listFooter({
    state,
    io,
    body,
    width,
    pluginErrorCount: model.pluginErrorCount,
    ...(model.discoverFiltered.length === 0 ? {} : { discoverCounter: window.counter }),
  });
}

function renderInstalledList(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  const contentWidth = contentWidthFor(width);
  const body: string[] = [];
  const selected = state.search.focused ? -1 : model.selectedIndex;

  const window = model.installedWindow;
  if (model.installedRows.length === 0) {
    if (model.qlower.length > 0) {
      body.push(
        renderTextWithStyles(`No items match "${state.search.query}"`, { color: Color.muted }),
      );
    } else {
      body.push(renderTextWithStyles("Manage plugins", { bold: true }));
      body.push(
        renderTextWithStyles("No plugins or MCP servers installed.", { color: Color.muted }),
      );
    }
  } else {
    if (window.markerAbove !== undefined) body.push(dimMarkerLine(window.markerAbove));
    for (let index = window.from; index < window.to; index++) {
      const row = model.installedRows[index]!;
      for (const line of renderInstalledRowLines(
        row,
        selected === index,
        state.installed.showDisabled,
        contentWidth,
      )) {
        body.push(line);
      }
    }
    if (window.markerBelow !== undefined) body.push(dimMarkerLine(window.markerBelow));
  }

  if (model.pendingReload) {
    body.push("");
    body.push(
      renderTextWithStyles("Run /reload to activate changes", {
        color: Color.muted,
        italic: true,
      }),
    );
  }

  body.push("");
  for (const line of installedInputGuideLines(contentWidth)) body.push(line);

  return listFooter({
    state,
    io,
    body,
    width,
    pluginErrorCount: model.pluginErrorCount,
  });
}

function renderMarketplacesList(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  const contentWidth = contentWidthFor(width);
  const body: string[] = [];
  const window = model.browseWindow;

  const installedCounts = new Map<string, number>();
  for (const installation of listPluginInstallations()) {
    installedCounts.set(
      installation.marketplace,
      (installedCounts.get(installation.marketplace) ?? 0) + 1,
    );
  }

  if (window.markerAbove !== undefined) body.push(dimMarkerLine(window.markerAbove));
  // Item 0 is the add-marketplace action; items 1.. are the known marketplaces.
  for (let itemIndex = window.from; itemIndex < window.to; itemIndex++) {
    if (itemIndex === 0) {
      for (const line of renderPanelPickerRowLines(
        {
          label: "+ Add Marketplace",
          selected: model.selectedIndex === 0,
          rows: 2,
          labelBold: true,
        },
        contentWidth,
      )) {
        body.push(line);
      }
      continue;
    }
    const m = model.marketplaces[itemIndex - 1]!;
    const selected = model.selectedIndex === itemIndex;
    body.push(marketplaceLabelLine(m.name, selected));
    body.push("    " + renderTextWithStyles(m.source, { color: Color.muted }));
    body.push(
      "    " +
        renderTextWithStyles(
          `${listMarketplacePlugins(m.name).length} available • ${installedCounts.get(m.name) ?? 0} installed • Updated ${formatMarketplaceDate(m.lastUpdated)}`,
          { color: Color.muted },
        ),
    );
    body.push("");
  }
  if (window.markerBelow !== undefined) body.push(dimMarkerLine(window.markerBelow));

  return listFooter({
    state,
    io,
    body,
    width,
    pluginErrorCount: model.pluginErrorCount,
  });
}

function renderErrors(state: PanelState, io: RenderIo, width: number): string[] {
  const { errors } = getSnapshot();
  const body: string[] = [];
  if (errors.length === 0) {
    body.push(renderTextWithStyles(" No plugin errors", { color: Color.muted }));
  } else {
    for (const error of errors) {
      body.push(
        renderTextWithStyles(`${error.pluginId ?? "unknown plugin"} · ${error.code}`, {
          color: Color.error,
        }),
      );
      body.push(renderTextWithStyles(`${error.path} · ${error.message}`, { color: Color.muted }));
      if (error.recoveryHint) {
        body.push(renderTextWithStyles(error.recoveryHint, { color: Color.muted }));
      }
      body.push("");
    }
  }
  return listFooter({
    state,
    io,
    body,
    width,
    pluginErrorCount: errors.length,
  });
}

export function renderAddMarketplace(state: PanelState, width: number): string[] {
  const body: string[] = [
    renderTextWithStyles("Add marketplace", { color: Color.textStrong, bold: true }),
    renderTextWithStyles("git URL, github owner/repo, or local path", { color: Color.muted }),
    "",
    renderTextWithStyles(Glyph.chevron, { color: Color.muted }) +
      renderTextWithStyles(`${state.marketplaces.addInput ?? ""}${Glyph.blockHalf}`, {
        color: Color.text,
      }),
  ];
  if (state.data.busy) {
    body.push(
      "",
      renderTextWithStyles(`${spinnerFrame(Date.now())} ${state.data.busy}`, {
        color: Color.muted,
      }),
    );
  }
  const spec: FooterPanelSpec = {
    command: "/plugins",
    flushTop: true,
    footerHints: [
      ["Enter", "add"],
      ["Esc", "cancel"],
    ],
    body,
  };
  return renderFooterPanel(spec, width);
}

function renderDiscoverDetails(
  state: PanelState,
  io: RenderIo,
  item: DiscoverItem,
  width: number,
): string[] {
  return framed(
    state,
    io,
    discoverDetailView({
      item,
      contentWidth: contentWidthFor(width),
      optionIndex: state.discover.optionIndex,
    }),
    width,
  );
}

function renderMarketplaceSubView(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  return framed(
    state,
    io,
    marketplaceDetailView({
      marketplace: model.selectedMarketplace,
      installedPlugins: model.marketplaceInstalledPlugins,
      view: state.marketplaces.view,
      selection: state.marketplaces.detailsSelection,
      contentWidth: contentWidthFor(width),
      busy: state.data.busy,
      notice: state.marketplaces.detailNotice,
    }),
    width,
  );
}

function renderInstalledDetail(
  state: PanelState,
  model: PanelModel,
  width: number,
  io: RenderIo,
): string[] {
  const detail = state.installed.detail;
  const contentWidth = contentWidthFor(width);
  switch (detail.kind) {
    case "plugin":
      return framed(
        state,
        io,
        pluginDetailView({
          plugin: detail.plugin,
          contentWidth,
          actions: installedDetailActions(detail.plugin, state.data.favorites),
          actionIndex: state.installed.actionIndex,
          notice: state.installed.notice,
        }),
        width,
      );
    case "skill":
      return framed(
        state,
        io,
        skillDetailView({
          item: detail.item,
          contentWidth,
          stateIndex: state.installed.skillStateIndex,
        }),
        width,
      );
    case "failed":
      return framed(state, io, failedPluginDetailView(detail), width);
    case "mcp":
      return framed(
        state,
        io,
        mcpDetailView({
          server: detail.server,
          contentWidth,
          busy: state.data.busy,
          menuIndex: state.installed.mcpMenuIndex,
        }),
        width,
      );
    case "mcp-tools":
      return framed(
        state,
        io,
        mcpToolsView({ server: detail.server, toolsIndex: state.installed.mcpToolsIndex }),
        width,
      );
    case "mcp-tool":
      return framed(
        state,
        io,
        mcpToolDetailView({ server: detail.server, tool: detail.tool, contentWidth }),
        width,
      );
    default:
      return renderInstalledList(state, model, width, io);
  }
}
