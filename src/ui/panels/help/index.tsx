import { CATALOG, type SlashKind } from "@/commands/index.ts";
import { Box, type Color as InkColor, Text } from "@/ink";
import { withStableIds } from "@/kernel/std/keys.ts";
import { overlayStack } from "@/store/index.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { Color } from "@/ui/theme/theme.ts";

export function HelpOverlay(): React.JSX.Element {
  const close = (): void => overlayStack.closeTop();
  const lines = withStableIds(helpLines());
  return (
    <FooterPanel
      command="/help"
      title="Slash commands"
      onCancel={close}
      footerHints={[["Esc", "close"]]}
    >
      {lines.map(({ id, line }) =>
        line.length === 0 ? (
          <Box key={id} height={1} />
        ) : (
          <Text key={id} color={colorForLine(line)} bold={isHeading(line)}>
            {line}
          </Text>
        ),
      )}
    </FooterPanel>
  );
}

function helpLines(): string[] {
  const lines = [
    "otherside cli",
    "",
    "Shortcuts",
    "  Enter          submit turn               Shift+Enter   newline",
    "  Tab            autocomplete slash        Shift+Tab     cycle permission mode",
    "  ↑ / ↓          input history             PgUp / PgDn   scroll transcript",
    "  Ctrl+Home/End  jump top / bottom",
    "  Esc            cancel overlay / stream   Ctrl+U        kill input line",
    "  Ctrl+C         close/clear/cancel        Ctrl+D        exit if empty",
    "",
    "Terminal tips",
    "  Option+drag    select text (macOS)       Alt+drag     select text (Linux)",
    "  altscreen locks native scrollback — use PgUp/PgDn",
    "",
    "Slash commands",
  ];

  for (const kind of ["instant", "toggle", "skill", "anchor", "auth", "panel"] as SlashKind[]) {
    const slashes = CATALOG.filter((entry) => entry.kind === kind).map((entry) => entry.name);
    if (slashes.length > 0) pushWrappedGroup(lines, kind, slashes);
  }
  lines.push("");
  lines.push("Type `/` to filter. Type `/<prefix>` to narrow.");
  return lines;
}

function pushWrappedGroup(lines: string[], label: string, slashes: string[]): void {
  const widthBudget = 78;
  const headerWidth = 12;
  let row: string[] = [];
  let rowLen = headerWidth;
  let firstRow = true;
  for (const name of slashes) {
    const cost = name.length + 2;
    if (row.length > 0 && rowLen + cost > widthBudget) {
      const prefix = firstRow ? label : "";
      lines.push(`  ${prefix.padEnd(8)}  /${row.join(" /")}`);
      firstRow = false;
      row = [];
      rowLen = headerWidth;
    }
    row.push(name);
    rowLen += cost;
  }
  if (row.length > 0) {
    const prefix = firstRow ? label : "";
    lines.push(`  ${prefix.padEnd(8)}  /${row.join(" /")}`);
  }
}

function isHeading(line: string): boolean {
  return !line.startsWith(" ") && !line.startsWith("Type `");
}

function colorForLine(line: string): InkColor {
  if (isHeading(line)) return Color.primaryGlow;
  if (line.startsWith("Type `")) return Color.muted;
  return Color.text;
}
