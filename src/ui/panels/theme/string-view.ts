import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { type BuiltinThemeSetting, customThemeIdFor } from "@/kernel/config/theme-names.ts";
import { readStoredThemeBySlug, type StoredTheme } from "@/kernel/theme/store.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { keyInput } from "@/ui/chrome/key-input.ts";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { hintFor, hintPair } from "@/ui/chrome/panel-hints.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  type ListPanelSpec,
  listPanelPageSize,
  panelContentWidth,
  renderFooterPanel,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { ThemeEditor } from "@/ui/panels/theme/editor.ts";
import {
  nameScreenBody,
  nameScreenHints,
  slotItems,
  slotPreviewLines,
  slotStatusLine,
  valueScreenBody,
  valueScreenHints,
} from "@/ui/panels/theme/editor-rows.ts";
import { themeSampleLines } from "@/ui/panels/theme/sample.ts";
import { applyStoredTheme, applyThemeSetting } from "@/ui/theme/custom/apply.ts";
import { listAvailableThemes } from "@/ui/theme/custom/catalog.ts";
import {
  isSyntaxHighlightingEnabled,
  setSyntaxHighlightingEnabled,
} from "@/ui/theme/syntax-highlighting.ts";
import { Color, Glyph, type ThemeSetting } from "@/ui/theme/theme.ts";

const BUILTIN_ROWS: { setting: BuiltinThemeSetting; label: string }[] = [
  { setting: "auto", label: "Auto (match terminal)" },
  { setting: "dark", label: "Dark mode" },
  { setting: "light", label: "Light mode" },
  { setting: "dark-daltonized", label: "Dark mode (colorblind-friendly)" },
  { setting: "light-daltonized", label: "Light mode (colorblind-friendly)" },
  { setting: "dark-ansi", label: "Dark mode (ANSI colors only)" },
  { setting: "light-ansi", label: "Light mode (ANSI colors only)" },
];

const NEW_THEME_LABEL = "New custom theme…";
const PANEL_TITLE = "Theme";
const PANEL_SUBTITLE = "Choose the text style that looks best with your terminal";
/** Marks the palette in force, which is not where the cursor is until Enter. */
const IN_FORCE_SUFFIX = ` ${Glyph.check}`;

type PickerRow =
  | { kind: "builtin"; setting: BuiltinThemeSetting; label: string }
  | { kind: "stored"; theme: StoredTheme }
  | { kind: "new" };

/**
 * A row in three parts: its position stays quiet, and the palette's name carries
 * the state. Being in force outranks being under the cursor, since the cursor
 * already has the chevron and the check has nothing else to say it with.
 */
function styledRowLabel(
  position: string,
  name: string,
  inForce: boolean,
  selected: boolean,
): string {
  const head = renderTextWithStyles(position, { color: Color.muted });
  if (inForce) {
    return (
      head +
      renderTextWithStyles(name + IN_FORCE_SUFFIX, {
        color: Color.success,
      })
    );
  }
  const nameColor = selected ? Color.panelAccent : Color.text;
  return head + renderTextWithStyles(name, { color: nameColor });
}

/**
 * Theme picker on the string model. Navigation live-previews the palette (the whole
 * tree repaints in the chosen colors); Enter persists and keeps it, Escape reverts to
 * the palette that was active on open. Stored themes list alongside the shipped ones
 * and open the editor, which owns its own screens inside this panel.
 */
class ThemePanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private baseline: ThemeSetting;
  private readonly firstLaunch: boolean;
  private cursor: number;
  private pageRows = 1;
  private rows: PickerRow[] = [];
  private editor: ThemeEditor | undefined;

  constructor(private readonly close: () => void) {
    const config = loadConfigSync();
    this.firstLaunch = config.theme === undefined;
    this.baseline = config.theme ?? "auto";
    this.reloadRows();
    this.cursor = Math.max(
      0,
      this.rows.findIndex((row) => this.settingFor(row) === this.baseline),
    );
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.applyPreview();
    ctx.requestRender();
  }

  unmount(): void {
    if (this.currentSetting() !== this.baseline) applyThemeSetting(this.baseline);
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const editor = this.editor;
    if (editor) return this.renderEditor(editor, width);
    return this.renderPicker(width);
  }

  handleKey(key: KeyEventData): void {
    if (this.editor) {
      this.handleEditorKey(this.editor, key);
      return;
    }
    this.handlePickerKey(key);
  }

  // -- picker ---------------------------------------------------------------

  private reloadRows(): void {
    this.rows = [
      ...BUILTIN_ROWS.map((row) => ({ kind: "builtin" as const, ...row })),
      ...listAvailableThemes().map((theme) => ({ kind: "stored" as const, theme })),
      { kind: "new" as const },
    ];
  }

  private settingFor(row: PickerRow | undefined): ThemeSetting | undefined {
    if (row?.kind === "builtin") return row.setting;
    if (row?.kind === "stored") return customThemeIdFor(row.theme.slug);
    return undefined;
  }

  private currentSetting(): ThemeSetting {
    return this.settingFor(this.rows[this.cursor]) ?? this.baseline;
  }

  private applyPreview(): void {
    const setting = this.settingFor(this.rows[this.cursor]);
    if (setting !== undefined) applyThemeSetting(setting);
  }

  private renderPicker(width: number): string[] {
    const spec: ListPanelSpec = {
      title: PANEL_TITLE,
      subtitle: PANEL_SUBTITLE,
      items: this.rows.map((row, index) => this.pickerItem(row, index)),
      cursor: this.cursor,
      maxRows: this.terminalRows(),
      footerHints: this.pickerHints(),
      bodySuffix: themeSampleLines(panelContentWidth(width)),
      // The label is the whole row, so there is no value column to reserve for.
      rowWidth: 0,
    };
    if (!this.firstLaunch) spec.command = "/theme";
    this.pageRows = listPanelPageSize(spec);
    return renderListPanel(spec, width);
  }

  /**
   * Rows read as a numbered sentence, and the check marks the palette in force
   * rather than the row under the cursor — browsing previews, Enter chooses, and
   * two marks are what tells those apart.
   */
  private pickerItem(row: PickerRow, index: number): ListPanelSpec["items"][number] {
    const position = `${index + 1}. `;
    const inForce = !this.firstLaunch && this.settingFor(row) === this.baseline;
    const name = this.rowLabel(row);
    const label = position + name + (inForce ? IN_FORCE_SUFFIX : "");
    return {
      id: this.rowId(row, index),
      label,
      styledLabel: styledRowLabel(position, name, inForce, index === this.cursor),
    };
  }

  private rowLabel(row: PickerRow): string {
    if (row.kind === "new") return NEW_THEME_LABEL;
    if (row.kind === "stored") return `${row.theme.name} (custom)`;
    return row.label;
  }

  private rowId(row: PickerRow, index: number): string {
    if (row.kind === "new") return "new-custom-theme";
    if (row.kind === "stored") return `custom:${row.theme.slug}`;
    return `${row.setting}-${index}`;
  }

  private pickerHints(): [string, string][] {
    const hints = [hintPair(hintFor("enterSelect"))];
    // Only a stored theme of the reader's own has anything to edit, so the hint
    // appears with it and the footer is otherwise the two the picker always has.
    if (this.editableRow() !== undefined) hints.push(hintPair(hintFor("edit")));
    hints.push(hintPair(hintFor("cancel")));
    return hints;
  }

  private handlePickerKey(key: KeyEventData): void {
    if (key.ctrl && key.name?.toLowerCase() === "e") {
      this.editSelected();
      return;
    }
    if (key.ctrl && key.name?.toLowerCase() === "t") {
      this.toggleSyntaxHighlighting();
      return;
    }
    const action = listSelectKey(key, {
      cursor: this.cursor,
      count: this.rows.length,
      pageSize: this.pageRows,
    });
    if (action !== undefined) {
      this.moveTo(action.cursor);
      if (action.activate) this.activate();
      return;
    }
    const panelAction = panelKey(key);
    if (panelAction === "confirm") this.activate();
    else if (panelAction === "close") this.cancel();
  }

  private moveTo(next: number): void {
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, next));
    this.applyPreview();
    this.ctx?.requestRender();
  }

  /**
   * Takes effect on the spot and persists on the spot — it belongs to no theme,
   * so cancelling the picker does not take it back.
   */
  private toggleSyntaxHighlighting(): void {
    const next = !isSyntaxHighlightingEnabled();
    setSyntaxHighlightingEnabled(next);
    void updateConfig((config) => {
      // Absent is the default, so the on state clears the key instead of storing
      // a false that later has to be told apart from never having been set.
      if (next) delete config.syntaxHighlightingDisabled;
      else config.syntaxHighlightingDisabled = true;
    });
    this.ctx?.requestRender();
  }

  private activate(): void {
    if (this.rows[this.cursor]?.kind === "new") {
      this.openEditor(new ThemeEditor());
      return;
    }
    this.save();
  }

  /**
   * The record under the cursor that the reader may edit, if any.
   *
   * A plugin's palette is the plugin's file. Editing would write a copy into the
   * reader's directory under a name that still says whose it was, so it declines
   * — and the hint asks the same question, so neither offers what the other refuses.
   */
  private editableRow(): StoredTheme | undefined {
    const row = this.rows[this.cursor];
    if (row?.kind !== "stored" || row.theme.source === "plugin") return undefined;
    return row.theme;
  }

  /** Opens the editor on the selected stored theme, with its values loaded. */
  private editSelected(): void {
    const theme = this.editableRow();
    if (theme === undefined) return;
    this.openEditor(new ThemeEditor(readStoredThemeBySlug(theme.slug) ?? theme));
  }

  private openEditor(editor: ThemeEditor): void {
    this.editor = editor;
    this.previewEditor();
    this.ctx?.requestRender();
  }

  private save(): void {
    const chosen = this.currentSetting();
    void updateConfig((config) => {
      config.theme = chosen;
    });
    applyThemeSetting(chosen);
    this.baseline = chosen;
    this.close();
  }

  private cancel(): void {
    applyThemeSetting(this.baseline);
    this.close();
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  // -- editor ---------------------------------------------------------------

  /** Repaints the tree in the theme being edited, so every edit is seen at once. */
  private previewEditor(): void {
    const editor = this.editor;
    if (!editor?.canContinue) return;
    applyStoredTheme(customThemeIdFor(editor.displaySlug), editor.toStored());
  }

  private renderEditor(editor: ThemeEditor, width: number): string[] {
    if (editor.screen === "slots") return this.renderSlots(editor, width);
    const spec: FooterPanelSpec =
      editor.screen === "name"
        ? {
            title: "New custom theme",
            body: nameScreenBody(editor),
            footerHints: nameScreenHints(editor),
            maxRows: this.terminalRows(),
          }
        : {
            title: editor.name,
            body: valueScreenBody(editor, editor.selected()!),
            footerHints: valueScreenHints(editor),
            maxRows: this.terminalRows(),
          };
    return renderFooterPanel(spec, width);
  }

  private renderSlots(editor: ThemeEditor, width: number): string[] {
    const spec: ListPanelSpec = {
      title: editor.name,
      subtitle: `based on ${editor.baseName}`,
      items: slotItems(editor),
      cursor: editor.cursor,
      maxRows: this.terminalRows(),
      search: { query: editor.filter, placeholder: "Filter color tokens…", focused: true },
      footerHints: [
        ["↑↓", "navigate"],
        ["Enter", "edit"],
        ["Tab", "reset"],
        ["Esc", "done"],
      ],
    };
    this.pageRows = listPanelPageSize(spec);
    const lines = renderListPanel(spec, width);
    lines.push(slotStatusLine(editor), ...slotPreviewLines(editor.selected()));
    return lines;
  }

  private handleEditorKey(editor: ThemeEditor, key: KeyEventData): void {
    switch (editor.screen) {
      case "name":
        this.handleNameKey(editor, key);
        return;
      case "slots":
        this.handleSlotsKey(editor, key);
        return;
      case "value":
        this.handleValueKey(editor, key);
        return;
    }
  }

  // The name and value screens are text drafts: their Enter and Escape accept and
  // abandon what is being typed, which is the draft's meaning and not the panel's.
  private handleNameKey(editor: ThemeEditor, key: KeyEventData): void {
    if (key.name === "escape") {
      this.closeEditor();
      return;
    }
    if (key.name === "return") {
      if (editor.continueToSlots()) this.previewEditor();
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "backspace") {
      editor.name = editor.name.slice(0, -1);
      this.ctx?.requestRender();
      return;
    }
    const text = keyInput(key);
    if (text.length > 0 && !key.ctrl && !key.meta) {
      editor.name += text;
      this.ctx?.requestRender();
    }
  }

  private handleSlotsKey(editor: ThemeEditor, key: KeyEventData): void {
    // The one editor screen that is a list rather than a draft, so its keys are
    // the panel's: leaving saves what was chosen, taking a row opens its value.
    const slotAction = panelKey(key);
    if (slotAction === "close") {
      editor.persist();
      this.finishEditor(editor);
      return;
    }
    if (slotAction === "confirm") {
      if (editor.openValue()) this.ctx?.requestRender();
      return;
    }
    if (key.name === "tab") {
      if (editor.resetSelected()) this.previewEditor();
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      editor.moveCursor(editor.cursor + (key.name === "down" ? 1 : -1));
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "backspace") {
      editor.setFilter(editor.filter.slice(0, -1));
      this.ctx?.requestRender();
      return;
    }
    const text = keyInput(key);
    if (text.length > 0 && !key.ctrl && !key.meta) {
      editor.setFilter(editor.filter + text);
      this.ctx?.requestRender();
    }
  }

  private handleValueKey(editor: ThemeEditor, key: KeyEventData): void {
    if (key.name === "escape") {
      editor.cancelValue();
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "return") {
      if (editor.commitValue()) this.previewEditor();
      this.ctx?.requestRender();
      return;
    }
    if (key.name === "backspace") {
      editor.draft = editor.draft.slice(0, -1);
      this.ctx?.requestRender();
      return;
    }
    const text = keyInput(key);
    if (text.length > 0 && !key.ctrl && !key.meta) {
      editor.draft += text;
      this.ctx?.requestRender();
    }
  }

  private closeEditor(): void {
    this.editor = undefined;
    this.applyPreview();
    this.ctx?.requestRender();
  }

  /** Leaves the editor and selects what was just built. */
  private finishEditor(editor: ThemeEditor): void {
    this.editor = undefined;
    if (!editor.canContinue) {
      this.closeEditor();
      return;
    }
    const id = customThemeIdFor(editor.displaySlug);
    this.reloadRows();
    const index = this.rows.findIndex((row) => this.settingFor(row) === id);
    if (index >= 0) this.cursor = index;
    void updateConfig((config) => {
      config.theme = id;
    });
    this.baseline = id;
    applyThemeSetting(id);
    this.close();
  }
}

export function createThemePanel(close: () => void): StringViewPanel {
  return new ThemePanel(close);
}
