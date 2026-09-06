import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import { customThemePath } from "@/kernel/theme/store.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { ListPanelSpec } from "@/ui/chrome/string-view-panel.ts";
import type { SlotRow, ThemeEditor } from "@/ui/panels/theme/editor.ts";
import { COLOR_VALUE_FORMS, parseColorValue } from "@/ui/theme/custom/color-value.ts";
import { Color } from "@/ui/theme/theme.ts";

const NAME_PLACEHOLDER = "my-theme";
const SWATCH = "██";

/** Text field with a block caret, matching how the other panels draw an input. */
function inputField(value: string, placeholder: string): string {
  if (value.length > 0) {
    return (
      renderTextWithStyles(value, { color: Color.text }) +
      renderTextWithStyles(" ", { inverse: true })
    );
  }
  const [first = " ", ...rest] = [...placeholder];
  return (
    renderTextWithStyles(first, { inverse: true }) +
    renderTextWithStyles(rest.join(""), { color: Color.muted })
  );
}

/** A block painted in the slot's colour, or blank when the value cannot render. */
function swatch(value: string): string {
  const color = parseColorValue(value);
  return color === undefined ? " ".repeat(SWATCH.length) : renderTextWithStyles(SWATCH, { color });
}

function colorLine(label: string, value: string): string {
  return `${renderTextWithStyles(`${label}:`, { color: Color.muted })} ${swatch(value)} ${renderTextWithStyles(value, { color: Color.muted })}`;
}

export function nameScreenBody(editor: ThemeEditor): string[] {
  const path = getDisplayPath(customThemePath(editor.displaySlug));
  return [
    `${renderTextWithStyles("Name:", { color: Color.muted })} ${inputField(editor.name, NAME_PLACEHOLDER)}`,
    renderTextWithStyles(`based on ${editor.baseName} · saved to ${path}`, {
      color: Color.muted,
    }),
  ];
}

export function nameScreenHints(editor: ThemeEditor): [string, string][] {
  const hints: [string, string][] = [];
  if (editor.canContinue) hints.push(["Enter", "continue"]);
  hints.push(["Esc", "cancel"]);
  return hints;
}

export function valueScreenBody(editor: ThemeEditor, row: SlotRow): string[] {
  const lines = [
    `${swatch(row.current)} ${renderTextWithStyles(row.slot, { bold: true })}`,
    colorLine("preset", row.preset),
    "",
    `${renderTextWithStyles("Value:", { color: Color.muted })} ${inputField(editor.draft, row.preset)}`,
  ];
  if (editor.draftRejected) {
    lines.push("");
    lines.push(renderTextWithStyles(`Accepts ${COLOR_VALUE_FORMS}`, { color: Color.warning }));
  }
  return lines;
}

export function valueScreenHints(editor: ThemeEditor): [string, string][] {
  const hints: [string, string][] = [];
  if (!editor.draftRejected) hints.push(["Enter", "save"]);
  hints.push(["Esc", "cancel"]);
  return hints;
}

/** The status line under the slot list: how much of the palette was changed. */
export function slotStatusLine(editor: ThemeEditor): string {
  const count = editor.overrideCount;
  const file = `${editor.displaySlug}.json`;
  const text =
    count === 0
      ? `editing ${file}`
      : `${count} ${count === 1 ? "color" : "colors"} customized · ${file}`;
  return renderTextWithStyles(text, { color: Color.muted });
}

export function slotPreviewLines(row: SlotRow | undefined): string[] {
  if (!row) return [];
  const lines = [colorLine("current", row.current)];
  if (row.overridden) lines.push(colorLine("preset", row.preset));
  return lines;
}

export function slotItems(editor: ThemeEditor): ListPanelSpec["items"] {
  return editor.rows().map((row) => ({
    id: row.slot,
    label: row.slot,
    styledLabel: `${swatch(row.current)} ${renderTextWithStyles(row.slot, { color: Color.text })}`,
    labelSuffix: row.overridden ? " (custom)" : undefined,
    value: row.current,
  }));
}
