import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/**
 * The rows above a panel's body: the command echo that says which slash command
 * opened it, and the title row where the name and the tabs share one line.
 *
 * Kept apart from the frame because it answers a different question — how the
 * panel names itself, rather than how many rows it may spend.
 */

export interface PanelTab {
  label: string;
}

/** What the title row draws from; a panel spec satisfies it by declaring these. */
export interface PanelHeader {
  title?: string | undefined;
  tabs?: PanelTab[] | undefined;
  activeTab?: number | undefined;
  /** `null` keeps the active tab while content has focus; an index gives it the tab cursor. */
  tabCursor?: number | null | undefined;
  /**
   * Focus-model tab row. When defined it replaces the legacy chip styles: every
   * chip pads its label with one space per side and chips sit one column apart;
   * the active chip renders the panel accent background with the inverse foreground and
   * bold while the header holds focus, and reverse-video bold while content
   * does; inactive chips render plain. Leave undefined until a panel adopts the
   * focus model — the legacy `tabCursor` styles stay untouched.
   */
  headerFocused?: boolean | undefined;
}

export function panelHasTabs(header: PanelHeader): boolean {
  return header.tabs !== undefined && header.tabs.length > 0;
}

export function panelTitleRowLine(
  header: PanelHeader,
  headlineColor: TerminalColor,
  indent: string,
): string {
  const hasTabs = panelHasTabs(header);
  let line = indent;
  if (header.title !== undefined) {
    line += renderTextWithStyles(header.title, { color: headlineColor, bold: true });
    if (hasTabs) {
      const marginRight =
        header.headerFocused !== undefined ? 1 : (header.activeTab ?? 0) === 0 ? 1 : 2;
      line += " ".repeat(marginRight);
    }
  }
  if (hasTabs) {
    line += tabsSegment(
      header.tabs ?? [],
      header.activeTab ?? 0,
      header.tabCursor,
      header.headerFocused,
    );
  }
  return line;
}

export function panelCommandBarLine(command: string, width: number): string {
  const fill = " ".repeat(Math.max(0, width - stringWidth(command) - stringWidth(Glyph.chevron)));
  return (
    renderTextWithStyles(Glyph.chevron, {
      color: Color.chevron,
      backgroundColor: Color.inverseBg,
    }) +
    renderTextWithStyles(command, {
      color: Color.userText,
      backgroundColor: Color.inverseBg,
      bold: true,
    }) +
    renderTextWithStyles(fill, { backgroundColor: Color.inverseBg })
  );
}

function tabsSegment(
  tabs: PanelTab[],
  activeTab: number,
  tabCursor: number | null | undefined,
  headerFocused: boolean | undefined,
): string {
  if (headerFocused !== undefined) {
    return tabs
      .map((tab, index) => focusModelTabChip(tab.label, index === activeTab, headerFocused))
      .join(" ");
  }
  let segment = "";
  for (let index = 0; index < tabs.length; index++) {
    segment += tabChip(
      tabs[index]!.label,
      index === activeTab,
      index === tabCursor,
      tabCursor !== undefined,
    );
    segment += " ".repeat(tabMarginRight(index, tabs.length, activeTab, tabCursor));
  }
  return segment;
}

/**
 * Chip for the focus-model tab row: the active chip carries the panel-accent
 * background with the inverse foreground while the header holds focus and
 * reverse-video while content does; inactive chips stay plain text.
 */
function focusModelTabChip(label: string, active: boolean, headerFocused: boolean): string {
  const padded = ` ${label} `;
  if (!active) return padded;
  if (headerFocused) {
    return renderTextWithStyles(padded, {
      bold: true,
      backgroundColor: Color.panelAccent,
      color: Color.tabSelectedText,
    });
  }
  return renderTextWithStyles(padded, { bold: true, inverse: true });
}

function tabChip(label: string, active: boolean, cursor: boolean, focusAwareTabs: boolean): string {
  if (focusAwareTabs) {
    if (!active) return ` ${label} `;
    return renderTextWithStyles(` ${label} `, {
      bold: true,
      backgroundColor: cursor ? Color.panelAccent : Color.inverseBg,
      ...(cursor ? { color: Color.tabSelectedText } : {}),
    });
  }
  if (!active) return label;
  return renderTextWithStyles(` ${label} `, {
    bold: true,
    backgroundColor: Color.panelAccent,
    color: Color.tabSelectedText,
  });
}

function tabMarginRight(
  index: number,
  count: number,
  activeTab: number,
  tabCursor: number | null | undefined,
): number {
  if (index + 1 === count) return 0;
  if (tabCursor !== undefined) return 1;
  return 3 - (index === activeTab ? 1 : 0) - (index + 1 === activeTab ? 1 : 0);
}
