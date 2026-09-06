import { CATALOG, type SlashKind } from "@/commands/index.ts";
import { advertisesShiftReturn } from "@/platform/apple-terminal/shift-return.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { type FooterPanelSpec, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const KIND_ORDER: SlashKind[] = ["instant", "toggle", "skill", "anchor", "auth", "panel"];
const GROUP_WIDTH_BUDGET = 78;
const GROUP_HEADER_WIDTH = 12;

/**
 * Static shortcuts + slash-command reference on the string model. A read-only catalog
 * inside a footer panel; Escape closes.
 */
class HelpPanel implements StringViewPanel {
  constructor(private readonly close: () => void) {}

  render(width: number): string[] {
    const body = helpLines().map((line) =>
      line.length === 0
        ? ""
        : renderTextWithStyles(line, { color: colorForLine(line), bold: isHeading(line) }),
    );
    const spec: FooterPanelSpec = {
      command: "/help",
      title: "Slash commands",
      footerHints: [["Esc", "close"]],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    if (panelKey(key) === "close") this.close();
  }
}

function helpLines(): string[] {
  const lines = [
    "otherside cli",
    "",
    "Shortcuts",
    advertisesShiftReturn()
      ? "  Enter          submit turn               Shift+Enter   newline"
      : "  Enter          submit turn               \\ + Enter     newline",
    "  Tab            autocomplete slash        Shift+Tab     cycle permission mode",
    "  ↑ / ↓          input history             Ctrl+O        full-screen transcript",
    "  Esc            cancel overlay / stream   Ctrl+U        kill input line",
    "  Ctrl+C         close/clear/cancel        Ctrl+D        exit if empty",
    "  Ctrl+Y         paste deleted text",
    "",
    "Full-screen transcript (Ctrl+O)",
    "  ↑ / ↓ or j/k   scroll                    Home / End    jump to top / bottom",
    "  Ctrl+U/Ctrl+D  half page                 /             search (n/N steps)",
    "",
    "Terminal tips",
    "  Option+drag    select text (macOS)       Alt+drag     select text (Linux)",
    "  altscreen locks native scrollback — read it back with Ctrl+O",
    "",
    "Slash commands",
  ];

  for (const kind of KIND_ORDER) {
    const slashes = CATALOG.filter((entry) => entry.kind === kind).map((entry) => entry.name);
    if (slashes.length > 0) pushWrappedGroup(lines, kind, slashes);
  }
  lines.push("");
  lines.push("Type `/` to filter. Type `/<prefix>` to narrow.");
  return lines;
}

function pushWrappedGroup(lines: string[], label: string, slashes: string[]): void {
  let row: string[] = [];
  let rowLen = GROUP_HEADER_WIDTH;
  let firstRow = true;
  for (const name of slashes) {
    const cost = name.length + 2;
    if (row.length > 0 && rowLen + cost > GROUP_WIDTH_BUDGET) {
      lines.push(`  ${(firstRow ? label : "").padEnd(8)}  /${row.join(" /")}`);
      firstRow = false;
      row = [];
      rowLen = GROUP_HEADER_WIDTH;
    }
    row.push(name);
    rowLen += cost;
  }
  if (row.length > 0) {
    lines.push(`  ${(firstRow ? label : "").padEnd(8)}  /${row.join(" /")}`);
  }
}

function isHeading(line: string): boolean {
  return !line.startsWith(" ") && !line.startsWith("Type `");
}

function colorForLine(line: string): TerminalColor {
  if (isHeading(line)) return Color.panelAccent;
  if (line.startsWith("Type `")) return Color.muted;
  return Color.text;
}

export function createHelpPanel(close: () => void): StringViewPanel {
  return new HelpPanel(close);
}
