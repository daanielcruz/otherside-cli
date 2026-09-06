import type { PluginInstallScope } from "@/engine/plugins/installations.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { SkillState } from "@/kernel/config/config.ts";
import type { McpToolInfo } from "@/kernel/mcp/index.ts";
import type { PanelSearchTransition } from "@/ui/chrome/panel-search.ts";
import type { McpServerRow } from "@/ui/panels/mcp/data.ts";
import type { InstalledItem } from "@/ui/panels/plugins/installed-rows.ts";
import type { DiscoverItem, MarketplaceView, Tab } from "@/ui/panels/plugins/types.ts";

/**
 * The panel's whole condition as one explicit record, grouped by concern. Every
 * transition returns a new record; the orchestrator holds the single reference.
 */

export type SkillItem = Extract<InstalledItem, { type: "skill" }>;

export type InstalledDetail =
  | { kind: "list" }
  | { kind: "plugin"; plugin: LoadedPlugin }
  | { kind: "mcp"; server: McpServerRow }
  | { kind: "mcp-tools"; server: McpServerRow }
  | { kind: "mcp-tool"; server: McpServerRow; tool: McpToolInfo }
  | { kind: "skill"; item: SkillItem }
  | {
      kind: "failed";
      name: string;
      marketplace: string;
      errors: readonly { message: string; recoveryHint?: string }[];
    };

/** Which tab holds the cursor and where each windowed list is scrolled to. */
export interface PanelNavState {
  readonly tab: Tab;
  readonly selected: number;
  readonly discoverStart: number;
  readonly marketplacesStart: number;
  readonly installedStart: number;
}

export interface PanelSearchState {
  readonly query: string;
  readonly focused: boolean;
  readonly cursorOffset?: number;
}

export interface DiscoverSurfaceState {
  readonly details: DiscoverItem | null;
  readonly optionIndex: number;
  readonly marketplaceFilter: string | null;
  readonly marked: ReadonlySet<string>;
}

export interface InstalledSurfaceState {
  readonly detail: InstalledDetail;
  readonly actionIndex: number;
  readonly notice: string | null;
  readonly skillStateIndex: number;
  readonly mcpMenuIndex: number;
  readonly mcpToolsIndex: number;
  readonly showDisabled: boolean;
  readonly keepInPlaceIds: ReadonlySet<string>;
}

export interface MarketplacesSurfaceState {
  readonly view: MarketplaceView;
  readonly detailsSelection: number;
  readonly addInput: string | null;
  /** Outcome of the last detail-screen update, reported above the action menu. */
  readonly detailNotice: { text: string; isError: boolean } | null;
}

/** What the async side feeds the surfaces: busy line, loads, and cache ticks. */
export interface PanelDataState {
  readonly busy: string | null;
  readonly commandResult: string | null;
  readonly catalogTick: number;
  readonly uninstalled: ReadonlySet<string>;
  readonly favorites: ReadonlySet<string>;
  readonly disabledMcpNames: ReadonlySet<string>;
  readonly standaloneMcp: readonly InstalledItem[];
}

export interface PanelState {
  readonly nav: PanelNavState;
  readonly search: PanelSearchState;
  readonly discover: DiscoverSurfaceState;
  readonly installed: InstalledSurfaceState;
  readonly marketplaces: MarketplacesSurfaceState;
  readonly data: PanelDataState;
}

export function initialPanelState(input: {
  commandResult: string | null;
  favorites: ReadonlySet<string>;
}): PanelState {
  return {
    nav: {
      tab: "discover",
      selected: 0,
      discoverStart: 0,
      marketplacesStart: 0,
      installedStart: 0,
    },
    search: { query: "", focused: false },
    discover: { details: null, optionIndex: 0, marketplaceFilter: null, marked: new Set() },
    installed: {
      detail: { kind: "list" },
      actionIndex: 0,
      notice: null,
      skillStateIndex: 0,
      mcpMenuIndex: 0,
      mcpToolsIndex: 0,
      showDisabled: false,
      keepInPlaceIds: new Set(),
    },
    marketplaces: { view: "list", detailsSelection: 0, addInput: null, detailNotice: null },
    data: {
      busy: null,
      commandResult: input.commandResult,
      catalogTick: 0,
      uninstalled: new Set(),
      favorites: input.favorites,
      disabledMcpNames: new Set(),
      standaloneMcp: [],
    },
  };
}

export function withNav(state: PanelState, patch: Partial<PanelNavState>): PanelState {
  return { ...state, nav: { ...state.nav, ...patch } };
}

export function withSearch(state: PanelState, patch: Partial<PanelSearchState>): PanelState {
  return { ...state, search: { ...state.search, ...patch } };
}

export function withDiscover(state: PanelState, patch: Partial<DiscoverSurfaceState>): PanelState {
  return { ...state, discover: { ...state.discover, ...patch } };
}

export function withInstalled(
  state: PanelState,
  patch: Partial<InstalledSurfaceState>,
): PanelState {
  return { ...state, installed: { ...state.installed, ...patch } };
}

export function withMarketplaces(
  state: PanelState,
  patch: Partial<MarketplacesSurfaceState>,
): PanelState {
  return { ...state, marketplaces: { ...state.marketplaces, ...patch } };
}

export function withData(state: PanelState, patch: Partial<PanelDataState>): PanelState {
  return { ...state, data: { ...state.data, ...patch } };
}

/** Entering a tab starts it fresh: cursor, search, windows and drill-downs reset. */
export function resetForTab(state: PanelState): PanelState {
  return {
    ...state,
    nav: { ...state.nav, selected: 0, discoverStart: 0, marketplacesStart: 0, installedStart: 0 },
    search: { query: "", focused: false },
    discover: { ...state.discover, details: null, optionIndex: 0 },
    installed: {
      ...state.installed,
      detail: { kind: "list" },
      actionIndex: 0,
      notice: null,
      skillStateIndex: 0,
      mcpMenuIndex: 0,
      mcpToolsIndex: 0,
      showDisabled: false,
      keepInPlaceIds: new Set(),
    },
    marketplaces: { ...state.marketplaces, view: "list", detailsSelection: 0, detailNotice: null },
  };
}

/** The installed drill-down's Esc ladder: tool → tools → server → list. */
export function backInstalledDetail(state: PanelState): PanelState {
  const detail = state.installed.detail;
  if (detail.kind === "mcp-tool") {
    return withInstalled(state, { detail: { kind: "mcp-tools", server: detail.server } });
  }
  if (detail.kind === "mcp-tools") {
    return withInstalled(state, { detail: { kind: "mcp", server: detail.server } });
  }
  return withInstalled(state, { detail: { kind: "list" }, actionIndex: 0, notice: null });
}

/**
 * A focused search box only claims the tab row once it holds text: the empty
 * box lets tab/←/→ keep switching tabs, and typing engages the lock. Renders
 * and key routing read the same predicate.
 */
export function searchEngaged(state: PanelState): boolean {
  return state.search.focused && state.search.query.length > 0;
}

/**
 * Adopt a shared search-machine transition. A query change resets the cursor
 * and the list windows so the narrowed list reads from its top.
 */
export function appliedSearchTransition(
  state: PanelState,
  transition: PanelSearchTransition,
): PanelState {
  const queryChanged = transition.state.query !== state.search.query;
  const searched = withSearch(state, {
    focused: transition.state.focused,
    query: transition.state.query,
    ...(transition.state.cursorOffset !== undefined
      ? { cursorOffset: transition.state.cursorOffset }
      : {}),
  });
  if (!queryChanged) return searched;
  return withNav(searched, { selected: 0, discoverStart: 0, installedStart: 0 });
}

/**
 * What a key decided beyond the next state: the async side runs these after the
 * state lands, so the pure key layer never touches the engine.
 */
export type PanelEffect =
  | { kind: "close" }
  | { kind: "install-batch"; items: DiscoverItem[]; scope?: PluginInstallScope }
  | { kind: "open-browser"; url: string }
  | { kind: "run-detail-action"; plugin: LoadedPlugin; actionId: string }
  | { kind: "apply-skill-state"; item: SkillItem; state: SkillState }
  | { kind: "cycle-skill"; item: SkillItem }
  | { kind: "toggle-plugin"; pluginId: string }
  | { kind: "toggle-favorite"; plugin: LoadedPlugin }
  | { kind: "toggle-mcp"; fullName: string; currentlyEnabled: boolean }
  | { kind: "open-mcp-detail"; fullName: string }
  | { kind: "authenticate-mcp"; fullName: string }
  | { kind: "run-mcp-option"; server: McpServerRow; optionId: string }
  | { kind: "submit-add-marketplace" }
  | { kind: "update-marketplace"; source: string; inDetail: boolean }
  | { kind: "remove-marketplace"; name: string }
  | { kind: "load-standalone-mcp" };
