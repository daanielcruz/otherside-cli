import { OTHERSIDE_VERSION } from "@/boot/version.ts";
import { listOutputStyles, type OutputStyleOption } from "@/engine/output-styles/loader.ts";
import { loadConfigSync, type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { updateSetting } from "@/kernel/config/update-setting.ts";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import {
  type CredentialsBundle,
  loadAll as loadCredentials,
} from "@/kernel/storage/credentials.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { applyBrokerEvent } from "@/store/subscribers/broker.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { cycleTabForKey } from "@/ui/chrome/panel-tabs.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  listOverflowLine,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  CONFIG_TABS,
  configDownKey,
  configSearchKey,
  configStepDirection,
  configTabId,
  configTabJump,
  configUpKey,
  halfPageRowCursor,
  languageDraftAfterKey,
  outputStyleCursorAfterKey,
} from "@/ui/panels/config/panel-keys.ts";
import {
  cycledImageGeneratorConfig,
  cycledImageParserModelConfig,
  cycledImageParserProviderConfig,
  cycledModelRoute,
  cycledPermissionMode,
  cycledProviderRoute,
  cycledVoiceProviderConfig,
  cycledWorkflowSizeConfig,
  type PendingProvider,
  toggledBoolConfig,
} from "@/ui/panels/config/row-actions.ts";
import {
  applyConfigPatch,
  configPatch,
  filterRows,
  rowsFor,
  type SettingsRow,
  type TabId,
} from "@/ui/panels/config/rows.ts";
import {
  type Focus,
  footerHints,
  languageEditorLines,
  languageFooterHints,
  outputStyleFooterHints,
  outputStylePickerLines,
  renderSettingsRow,
  settingsColumnWidth,
} from "@/ui/panels/config/view-rows.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const CONTENT_PAD = 2;

/**
 * Settings overlay on the string model. Tabbed Details/Config footer panel; Config
 * rows cycle/toggle via Enter/←/→ (and Space), persist through `updateConfig`, and
 * session-scoped broker fields patch via `dispatch`. The panel opens with search
 * focused; `up` hands focus to the tab header (shared chrome focus model: chips,
 * `cycleTabForKey`, `searchKeyTransition`) and `down` returns it. The language row
 * opens a free-text editor. Escape cancels the editor or clears/exits search first,
 * and closes only from the root view (committing any pending provider/model change).
 */
class ConfigPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private cfg: UserConfig;
  private tabIdx: number;
  private focus: Focus;
  private query = "";
  private searchCursor: number | undefined;
  private rowIdx = 0;
  private listOffset = 0;
  /** Setting rows the last frame showed at once; the half-page keys step by half. */
  private listRows = 1;
  private credentials: CredentialsBundle | null = null;
  private languageDraft = "";
  private pendingProvider: PendingProvider | null = null;
  private stylePicker: { options: OutputStyleOption[]; cursor: number } | null = null;
  /** Merged view of the style (a project-local value shadows the user one). */
  private outputStyleValue: string;

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    this.cfg = loadConfigSync();
    this.outputStyleValue = resolveConfig(process.cwd()).outputStyle ?? "default";
    this.languageDraft = this.cfg.language ?? "";
    this.tabIdx = resolveInitialTab(props);
    // The panel opens ready to filter: search holds focus on the config tab and
    // the header only takes it via `up`. A tab without search keeps the header.
    this.focus = CONFIG_TABS[this.tabIdx]?.id === "config" ? "search" : "tabs";
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    void loadCredentials()
      .then((loaded) => {
        this.credentials = loaded;
        this.ctx?.requestRender();
      })
      .catch(() => {
        this.credentials = {};
        this.ctx?.requestRender();
      });
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const activeTab = configTabId(this.tabIdx);
    const filtered = this.filteredRows();
    if (this.rowIdx >= filtered.length) this.rowIdx = Math.max(0, filtered.length - 1);
    const selectedRow = filtered[this.rowIdx];
    const editingLanguage = this.focus === "language";
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);

    const spec: FooterPanelSpec = {
      command: "/config",
      tabs: CONFIG_TABS.map(({ label }) => ({ label })),
      activeTab: this.tabIdx,
      headerFocused: this.focus === "tabs",
      footerHints: editingLanguage
        ? languageFooterHints()
        : footerHints(activeTab, this.focus, selectedRow),
      body: [],
    };
    if (activeTab === "config" && !editingLanguage && this.focus !== "outputStyle") {
      spec.search = {
        query: this.query,
        placeholder: "Search settings…",
        focused: this.focus === "search",
        ...(this.searchCursor !== undefined ? { cursorOffset: this.searchCursor } : {}),
      };
      spec.searchMarginTop = 2;
    }

    if (this.focus === "outputStyle" && this.stylePicker !== null) {
      spec.body = outputStylePickerLines(
        this.stylePicker.options,
        this.stylePicker.cursor,
        this.outputStyleValue,
      );
      spec.footerHints = outputStyleFooterHints();
    } else if (editingLanguage) {
      spec.body = languageEditorLines(this.languageDraft);
    } else if (filtered.length === 0) {
      spec.body = [
        renderTextWithStyles(`No settings match "${this.query}"`, { color: Color.muted }),
      ];
    } else {
      spec.body = this.settingsListBody(filtered, contentWidth, spec, width);
    }

    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    if (this.focus === "outputStyle") {
      this.handleStylePickerKey(key);
      return;
    }
    if (this.focus === "language") {
      this.handleLanguageKey(key);
      return;
    }

    const cycledTab = cycleTabForKey({
      key,
      activeTab: this.tabIdx,
      tabCount: CONFIG_TABS.length,
      headerFocused: this.focus === "tabs",
    });
    if (cycledTab !== undefined) {
      this.tabIdx = cycledTab;
      this.rowIdx = 0;
      this.ctx?.requestRender();
      return;
    }

    if (this.applySearchTransition(key)) return;

    const jump = configTabJump(key, this.tabIdx, this.focus);
    if (jump !== undefined) {
      this.tabIdx = jump.tabIdx;
      this.focus = jump.focus;
      this.rowIdx = 0;
      this.listOffset = 0;
      this.ctx?.requestRender();
      return;
    }

    if (key.ctrl && (key.name === "u" || key.name === "d")) {
      if (this.focus === "body") {
        const rows = this.filteredRows();
        if (rows.length > 0) {
          this.rowIdx = halfPageRowCursor(
            this.rowIdx,
            this.listRows,
            rows.length,
            key.name === "d" ? 1 : -1,
          );
          this.ctx?.requestRender();
        }
      }
      return;
    }
    if (key.name === "up") {
      const move = configUpKey({
        focus: this.focus,
        activeTab: configTabId(this.tabIdx),
        rowIdx: this.rowIdx,
      });
      if (move !== undefined) {
        if (move.focus !== undefined) this.focus = move.focus;
        if (move.rowIdx !== undefined) this.rowIdx = move.rowIdx;
        this.ctx?.requestRender();
      }
      return;
    }
    if (key.name === "down") {
      const move = configDownKey({
        focus: this.focus,
        activeTab: configTabId(this.tabIdx),
        rowIdx: this.rowIdx,
        rowCount: this.filteredRows().length,
      });
      if (move !== undefined) {
        if (move.focus !== undefined) this.focus = move.focus;
        if (move.rowIdx !== undefined) this.rowIdx = move.rowIdx;
        this.ctx?.requestRender();
      }
      return;
    }
    if (panelKey(key) === "close") {
      // Root-view leave: search and language consume theirs above, so the panel
      // only closes from the header or the list.
      this.commitAndClose();
      return;
    }

    if (this.focus !== "body") return;

    if (configStepDirection(key) !== null) {
      const selected = this.filteredRows()[this.rowIdx];
      if (
        selected &&
        selected.kind !== "readonly" &&
        selected.kind !== "modelPanel" &&
        selected.kind !== "outputStyle"
      ) {
        this.applyRow(selected, configStepDirection(key) ?? 0);
      }
      return;
    }
    const rowAction = panelKey(key);
    if (rowAction === "confirm") {
      const selected = this.filteredRows()[this.rowIdx];
      if (selected) this.applyRow(selected, 0);
      return;
    }
    if (rowAction === "toggle") {
      const selected = this.filteredRows()[this.rowIdx];
      if (selected) {
        this.applyRow(
          selected,
          selected.kind === "language" || selected.kind === "modelPanel" ? 0 : 1,
        );
      }
    }
  }

  /**
   * Route the key through the shared search machine. Only the config tab has a
   * search box; the tab row above it makes `up` an exit to the header.
   */
  private applySearchTransition(key: KeyEventData): boolean {
    if (configTabId(this.tabIdx) !== "config") return false;
    const update = configSearchKey(key, {
      focused: this.focus === "search",
      query: this.query,
      cursorOffset: this.searchCursor,
    });
    if (update === undefined) return false;
    if (update.resetRows) this.rowIdx = 0;
    this.query = update.query;
    this.searchCursor = update.cursorOffset;
    if (update.focus !== undefined) this.focus = update.focus;
    this.ctx?.requestRender();
    return true;
  }

  private handleStylePickerKey(key: KeyEventData): void {
    const picker = this.stylePicker;
    if (picker === null) return;
    const outcome = outputStyleCursorAfterKey(picker.cursor, picker.options.length, key);
    if (outcome === undefined) return;
    if (outcome.kind === "move") {
      picker.cursor = outcome.cursor;
    } else {
      if (outcome.kind === "commit") {
        const chosen = picker.options[picker.cursor];
        if (chosen !== undefined) {
          this.outputStyleValue = chosen.value;
          void updateSetting("outputStyle", chosen.value, { scope: "local", cwd: process.cwd() });
        }
      }
      this.stylePicker = null;
      this.focus = "body";
    }
    this.ctx?.requestRender();
  }

  private handleLanguageKey(key: KeyEventData): void {
    const outcome = languageDraftAfterKey(this.languageDraft, key);
    if (outcome === undefined) return;
    if (outcome.kind === "commit") {
      const next: UserConfig = { ...this.cfg };
      if (outcome.draft) next.language = outcome.draft;
      else delete next.language;
      this.persist(next);
      this.languageDraft = outcome.draft;
      this.focus = "body";
      this.ctx?.requestRender();
      return;
    }
    if (outcome.kind === "cancel") {
      this.languageDraft = this.cfg.language ?? "";
      this.focus = "body";
      this.ctx?.requestRender();
      return;
    }
    this.languageDraft = outcome.draft;
    this.ctx?.requestRender();
  }

  private filteredRows(): SettingsRow[] {
    return filterRows(this.currentRows(), this.query);
  }

  private settingsListBody(
    rows: SettingsRow[],
    contentWidth: number,
    spec: FooterPanelSpec,
    width: number,
  ): string[] {
    const terminalRows = this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
    const bodyRows = footerPanelBodyBudget(spec, terminalRows, width);
    const size = Math.max(1, bodyRows - 2);
    this.listRows = size;
    const window = computeListWindow({
      cursor: this.rowIdx,
      total: rows.length,
      size,
      anchor: "edge",
      previousStart: this.listOffset,
    });
    this.listOffset = window.from;

    // Measured over the whole list rather than the window, so the value column
    // does not shift under the reader as they scroll.
    const columnWidth = settingsColumnWidth(rows);
    const body: string[] = [];
    if (window.above > 0) body.push(listOverflowLine("up", window.above, "above", CONTENT_PAD));
    for (let index = window.from; index < window.to; index++) {
      const row = rows[index]!;
      body.push(
        renderSettingsRow(
          row,
          index === this.rowIdx && this.focus === "body",
          contentWidth,
          columnWidth,
        ),
      );
    }
    if (window.below > 0) body.push(listOverflowLine("down", window.below, "below", CONTENT_PAD));
    return body;
  }

  private currentRows(): SettingsRow[] {
    return rowsFor({
      tab: configTabId(this.tabIdx),
      state: this.effectiveState(),
      // The row shows the resolved style, which a project-local write can own.
      cfg: { ...this.cfg, outputStyle: this.outputStyleValue },
      version: OTHERSIDE_VERSION,
      credentials: this.credentials,
    });
  }

  private effectiveState(): Readonly<BrokerState> {
    const state = readStringViewBrokerState();
    return this.pendingProvider ? { ...state, ...this.pendingProvider } : state;
  }

  private persist(next: UserConfig): void {
    const patch = configPatch(this.cfg, next);
    this.cfg = next;
    void updateConfig((current) => {
      applyConfigPatch(current, patch);
    });
    this.ctx?.requestRender();
  }

  private commitAndClose(): void {
    if (this.pendingProvider) {
      const { provider, model, fastMode } = this.pendingProvider;
      applyBrokerEvent(
        { kind: "set_route", route: { provider, model }, fastMode },
        { provider, model, fastMode },
      );
      this.persist({ ...this.cfg, defaultProvider: provider, defaultModel: model });
      this.pendingProvider = null;
    }
    this.close();
  }

  private applyRow(row: SettingsRow, direction: number): void {
    switch (row.kind) {
      case "provider":
        this.cycleProvider(direction);
        break;
      case "model":
        this.cycleModel(direction);
        break;
      case "modelPanel":
        if (direction === 0) overlayStack.open("model");
        break;
      case "outputStyle": {
        const options = listOutputStyles(process.cwd());
        const active = options.findIndex((option) => option.value === this.outputStyleValue);
        this.stylePicker = { options, cursor: Math.max(0, active) };
        this.focus = "outputStyle";
        this.ctx?.requestRender();
        break;
      }
      case "permission": {
        const state = readStringViewBrokerState();
        const mode = cycledPermissionMode(state.permissionMode, direction);
        applyBrokerEvent({ kind: "set_permission_mode", mode }, { permissionMode: mode });
        this.persist({ ...this.cfg, defaultMode: mode });
        break;
      }
      case "bool":
        this.toggleBool(row.id, direction);
        break;
      case "language":
        if (direction === 0) {
          this.languageDraft = this.cfg.language ?? "";
          this.focus = "language";
          this.ctx?.requestRender();
        }
        break;
      case "imageGeneratorProvider":
        this.persist(cycledImageGeneratorConfig(this.cfg, this.credentials, direction));
        break;
      case "voiceProvider":
        this.persist(cycledVoiceProviderConfig(this.cfg, this.credentials, direction));
        break;
      case "imageParserProvider":
        this.persist(
          cycledImageParserProviderConfig(
            this.cfg,
            this.credentials,
            readStringViewBrokerState().provider,
            direction,
          ),
        );
        break;
      case "imageParserModel": {
        const next = cycledImageParserModelConfig(this.cfg, direction);
        if (next !== null) this.persist(next);
        break;
      }
      case "workflowSizeGuideline":
        this.persist(cycledWorkflowSizeConfig(this.cfg, direction));
        break;
      case "readonly":
        break;
    }
  }

  private cycleProvider(direction: number): void {
    const route = cycledProviderRoute(
      this.cfg,
      this.credentials,
      this.effectiveState().provider,
      direction,
    );
    if (route !== null) this.setPendingRoute(route.provider, route.model, route.fastMode);
  }

  private cycleModel(direction: number): void {
    if (direction === 0) {
      overlayStack.open("model");
      return;
    }
    const baseline = readStringViewBrokerState();
    const route = cycledModelRoute(
      this.effectiveState(),
      this.pendingProvider?.fastMode ?? baseline.fastMode,
      direction,
    );
    if (route !== null) this.setPendingRoute(route.provider, route.model, route.fastMode);
  }

  private setPendingRoute(
    provider: PendingProvider["provider"],
    model: string,
    fastMode: boolean,
  ): void {
    const baseline = readStringViewBrokerState();
    if (
      provider === baseline.provider &&
      model === baseline.model &&
      fastMode === baseline.fastMode
    ) {
      this.pendingProvider = null;
    } else {
      this.pendingProvider = { provider, model, fastMode };
    }
    this.ctx?.requestRender();
  }

  private toggleBool(id: string | undefined, direction = 0): void {
    const toggle = toggledBoolConfig(this.cfg, id, readStringViewBrokerState(), direction);
    if (toggle === null) return;
    if (toggle.effect?.kind === "fastMode") {
      const { enabled } = toggle.effect;
      applyBrokerEvent({ kind: "set_fast_mode", enabled }, { fastMode: enabled });
    }
    if (toggle.effect?.kind === "orchestrationMode") {
      const { mode } = toggle.effect;
      applyBrokerEvent({ kind: "set_orchestration_mode", mode }, { orchestrationMode: mode });
    }
    this.persist(toggle.cfg);
    if (toggle.effect?.kind === "verbose") {
      dispatch({ type: "view/setVerboseTranscript", verbose: toggle.effect.verbose });
    }
  }
}

function resolveInitialTab(props: unknown): number {
  let initialTab: TabId | undefined;
  if (typeof props === "object" && props !== null && "initialTab" in props) {
    const value = (props as { initialTab?: unknown }).initialTab;
    if (value === "details" || value === "config") initialTab = value;
  }
  const idx = initialTab ? CONFIG_TABS.findIndex((tab) => tab.id === initialTab) : 1;
  return idx >= 0 ? idx : 1;
}

export function createConfigPanel(close: () => void, props?: unknown): StringViewPanel {
  return new ConfigPanel(close, props);
}
