import type { OutputStyleOption } from "@/engine/output-styles/loader.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { hintChord, hintFor, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import { labelColumnWidth, renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import type { SettingsRow, TabId } from "@/ui/panels/config/rows.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const LANGUAGE_PLACEHOLDER = "e.g., Japanese, 日本語, Español…";

export type Focus = "tabs" | "search" | "body" | "language" | "outputStyle";

/**
 * The column this list's values start at. Every row is measured, not just the
 * ones on screen, so scrolling never shifts the column under the reader.
 */
export function settingsColumnWidth(rows: readonly SettingsRow[]): number {
  return labelColumnWidth(rows.map((row) => row.label + (row.labelSuffix ?? "")));
}

export function renderSettingsRow(
  row: SettingsRow,
  selected: boolean,
  contentWidth: number,
  columnWidth: number,
): string {
  if (row.label.length === 0) return "";
  if (row.kind === "modelPanel") {
    const marker = renderTextWithStyles(selected ? Glyph.chevron : "  ", {
      color: selected ? Color.panelAccent : Color.steel,
    });
    return marker + renderTextWithStyles("More...", { color: Color.steel, bold: true });
  }
  return renderPanelRowLine(
    {
      label: row.label,
      ...(row.labelSuffix !== undefined ? { labelSuffix: row.labelSuffix } : {}),
      ...(row.labelSuffixWidth !== undefined ? { labelSuffixWidth: row.labelSuffixWidth } : {}),
      value: row.value,
      description: row.description,
      selected,
      active: row.active,
      muted: row.muted,
      valueColor: row.valueColor,
    },
    contentWidth,
    columnWidth,
  );
}

export function languageEditorLines(draft: string): string[] {
  const lines: string[] = [];
  lines.push(
    renderTextWithStyles("Enter your preferred response and voice language:", {
      color: Color.text,
    }),
  );
  lines.push("");
  lines.push(renderTextWithStyles(Glyph.chevron, { color: Color.chevron }) + languageInput(draft));
  lines.push("");
  lines.push(renderTextWithStyles("Leave empty for default (English)", { color: Color.muted }));
  return lines;
}

function languageInput(value: string): string {
  if (value.length > 0) {
    return (
      renderTextWithStyles(value, { color: Color.text }) +
      renderTextWithStyles(" ", { inverse: true })
    );
  }
  const [first = " ", ...rest] = [...LANGUAGE_PLACEHOLDER];
  return (
    renderTextWithStyles(first, { inverse: true }) +
    renderTextWithStyles(rest.join(""), { color: Color.muted })
  );
}

export function languageFooterHints(): [string, string][] {
  return [
    ["Enter", "save"],
    ["Esc", "cancel"],
  ];
}

/**
 * Style picker body: title, dim subtitle, then a numbered roster with the
 * active entry check-marked and the cursor row chevroned.
 */
export function outputStylePickerLines(
  options: readonly OutputStyleOption[],
  cursor: number,
  activeValue: string,
): string[] {
  const lines: string[] = [
    renderTextWithStyles("Preferred output style", { bold: true, color: Color.textStrong }),
    "",
    renderTextWithStyles("This changes how Otherside communicates with you", {
      color: Color.muted,
    }),
    "",
  ];
  const labelBudget = Math.max(
    ...options.map((option, index) => stringWidth(labelOf(option, index))),
  );
  options.forEach((option, index) => {
    const selected = index === cursor;
    const marker = renderTextWithStyles(selected ? `${Glyph.chevron} ` : "  ", {
      color: Color.panelAccent,
    });
    const active = option.value === activeValue ? " ✔" : "";
    const label = `${labelOf(option, index)}${active}`;
    const pad = " ".repeat(Math.max(0, labelBudget + 2 - stringWidth(label)) + 2);
    lines.push(
      marker +
        renderTextWithStyles(label, {
          color: selected ? Color.panelAccent : Color.text,
          bold: selected,
        }) +
        pad +
        renderTextWithStyles(option.description, { color: Color.muted }),
    );
  });
  return lines;
}

function labelOf(option: OutputStyleOption, index: number): string {
  return `${index + 1}. ${option.label}`;
}

export function outputStyleFooterHints(): [string, string][] {
  return [
    ["Enter", "confirm"],
    ["Esc", "cancel"],
  ];
}

/** One shared-vocabulary hint in the panel spec's `[chord, label]` pair shape. */
function hintPair(hint: PanelHint): [string, string] {
  return [hintChord(hint.keys), hint.label];
}

/**
 * Footer hints by focus state: the header advertises tab switching and the way
 * back down, search the filter flow, and the list its row actions. A tab
 * without content below the header drops the return hint.
 */
export function footerHints(
  tab: TabId,
  focus: Focus,
  selectedRow: SettingsRow | undefined,
): [string, string][] {
  if (tab !== "config") return [hintFor("switch"), hintFor("close")].map(hintPair);
  if (focus === "tabs") {
    return [hintFor("switch"), hintFor("return"), hintFor("close")].map(hintPair);
  }
  if (focus === "search") {
    return [hintFor("typeToFilter"), hintFor("select"), hintFor("tabs"), hintFor("clear")].map(
      hintPair,
    );
  }
  const rowAction: PanelHint =
    selectedRow?.kind === "modelPanel"
      ? { keys: ["enter", "space"], label: "to open /model" }
      : hintFor("change");
  return [rowAction, hintFor("search"), hintFor("close")].map(hintPair);
}
