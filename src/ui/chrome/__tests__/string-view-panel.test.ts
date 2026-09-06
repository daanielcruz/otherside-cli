import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  type ListPanelSpec,
  renderFooterPanel,
  renderListPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const WIDTH = 80;
const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

describe("renderFooterPanel", () => {
  it("draws a full-width command bar, a rule, the title, and joined hints", () => {
    const lines = renderFooterPanel(
      {
        command: "/theme",
        title: "Theme picker",
        footerHints: [
          ["↑↓", "preview"],
          ["Esc", "cancel"],
        ],
        body: ["  row one"],
      },
      WIDTH,
    );
    const plain = lines.map(stripAnsi);

    expect(stringWidth(lines[0]!)).toBe(WIDTH);
    expect(plain[0]).toContain("/theme");
    expect(plain[1]).toBe("");
    expect(plain[2]).toBe(Glyph.boxHLine.repeat(WIDTH));
    expect(plain.some((line) => line.includes("Theme picker"))).toBe(true);
    expect(plain.some((line) => line.trim() === "↑↓ preview · Esc cancel")).toBe(true);
    expect(
      lines.some((line) =>
        line.includes(
          renderTextWithStyles("↑↓ preview · Esc cancel", {
            color: Color.muted,
            italic: true,
          }),
        ),
      ),
    ).toBe(true);
    // A footer panel always ends on a trailing blank line.
    expect(plain.at(-1)).toBe("");
  });

  it("omits the command bar and opens on the rule when no command is given", () => {
    const plain = renderFooterPanel({ title: "Skills", body: [] }, WIDTH).map(stripAnsi);
    expect(plain[0]).toBe(Glyph.boxHLine.repeat(WIDTH));
  });

  it("keeps the configured tab-to-search gap and one row below search", () => {
    const plain = renderFooterPanel(
      {
        tabs: [{ label: "Details" }, { label: "Config" }],
        activeTab: 1,
        tabCursor: null,
        searchMarginTop: 2,
        search: { query: "", placeholder: "Search settings…", focused: true },
        body: ["row"],
      },
      WIDTH,
    ).map(stripAnsi);

    const tabRow = plain.findIndex((line) => line.includes("Details") && line.includes("Config"));
    const searchTop = plain.findIndex((line) => line.includes(Glyph.boxTopLeft));
    const searchBottom = plain.findIndex((line) => line.includes(Glyph.boxBottomLeft));
    expect(searchTop - tabRow - 1).toBe(2);
    expect(plain[searchBottom + 1]).toBe("");
    expect(plain[searchBottom + 2]).toContain("row");
  });

  it("renders subtitles bold with a trailing gap unless search follows", () => {
    const withoutSearch = renderFooterPanel(
      {
        title: "Plugins",
        subtitle: "Manage marketplaces",
        flushTop: true,
        body: ["row"],
      },
      WIDTH,
    );
    const plain = withoutSearch.map(stripAnsi);
    const subtitleRow = plain.findIndex((line) => line.includes("Manage marketplaces"));
    expect(withoutSearch[subtitleRow]).toContain(
      renderTextWithStyles("Manage marketplaces", { bold: true }),
    );
    expect(plain[subtitleRow + 1]).toBe("");
    expect(plain[subtitleRow + 2]).toContain("row");

    const withSearch = renderFooterPanel(
      {
        title: "Plugins",
        subtitle: "Discover plugins",
        subtitleSuffix: " (1/9)",
        flushTop: true,
        search: { query: "", placeholder: "Search…", focused: false },
        body: ["row"],
      },
      WIDTH,
    );
    const withSearchPlain = withSearch.map(stripAnsi);
    const discoverRow = withSearchPlain.findIndex((line) => line.includes("Discover plugins"));
    expect(withSearch[discoverRow]).toContain(
      renderTextWithStyles(" (1/9)", { color: Color.muted }),
    );
    expect(withSearchPlain[discoverRow + 1]).toContain(Glyph.boxTopLeft);
  });

  it("distinguishes active, plain, and cursor-carrying tabs", () => {
    const base = {
      tabs: [{ label: "Details" }, { label: "Config" }],
      activeTab: 1,
      body: [],
    };
    const active = renderFooterPanel({ ...base, tabCursor: null }, WIDTH)[1]!;
    const cursor = renderFooterPanel({ ...base, tabCursor: 1 }, WIDTH)[1]!;

    expect(stripAnsi(active)).toContain(" Details ");
    expect(active).toContain(
      renderTextWithStyles(" Config ", { bold: true, backgroundColor: Color.inverseBg }),
    );
    expect(cursor).toContain(
      renderTextWithStyles(" Config ", {
        bold: true,
        backgroundColor: Color.panelAccent,
        color: Color.tabSelectedText,
      }),
    );
  });

  it("renders focus-model chips by header focus and keeps one column between chips", () => {
    const base = {
      title: "Config",
      tabs: [{ label: "Details" }, { label: "Config" }],
      activeTab: 1,
      body: [],
    };
    const headerRow = renderFooterPanel({ ...base, headerFocused: true }, WIDTH)[1]!;
    const contentRow = renderFooterPanel({ ...base, headerFocused: false }, WIDTH)[1]!;

    // Active chip: panel-accent background + inverse foreground while the header
    // holds focus; reverse-video while content does. Inactive chips stay plain.
    expect(headerRow).toContain(
      renderTextWithStyles(" Config ", {
        bold: true,
        backgroundColor: Color.panelAccent,
        color: Color.tabSelectedText,
      }),
    );
    expect(contentRow).toContain(renderTextWithStyles(" Config ", { bold: true, inverse: true }));
    for (const row of [headerRow, contentRow]) {
      // Title, a one-column margin, then self-padded chips one column apart.
      expect(stripAnsi(row)).toBe("  Config  Details   Config ");
    }
  });

  // Row-width law: a row wider than the frame breaks physically in the terminal
  // and desynchronizes the writer's row accounting, ghosting neighbouring rows.
  it("clips every emitted row to the frame width", () => {
    const narrow = 60;
    const lines = renderFooterPanel(
      {
        title: "Bash command",
        flushTop: true,
        footerHints: [
          ["↑↓", "select"],
          ["Enter", "confirm"],
          ["Esc", "cancel"],
          ["1-3", "quick"],
          ["Tab", "amend"],
        ],
        body: ["  1. Yes", "  2. Yes, and don't ask again for: while *", "  3. No"],
      },
      narrow,
    );
    for (const line of lines) {
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(narrow);
    }
    // Hints that outgrow the frame wrap onto following rows instead of clipping.
    const plain = lines.map(stripAnsi);
    expect(plain.find((line) => line.includes("↑↓ select"))).toBeDefined();
    expect(plain.find((line) => line.includes("Tab amend"))).toBeDefined();
  });
});

describe("renderPanelRowLine", () => {
  it("pads the label to the column width and marks the selected row", () => {
    const line = stripAnsi(
      renderPanelRowLine({ label: "Auto", value: "Match terminal", selected: true }, WIDTH, 20),
    );
    expect(line.startsWith(Glyph.chevron)).toBe(true);
    // marker (2 cells) + 20-cell label column places the value at column 22.
    expect(line.indexOf("Match terminal")).toBe(22);
  });

  it("uses a blank gutter for an unselected, inactive row", () => {
    const line = stripAnsi(renderPanelRowLine({ label: "Auto" }, WIDTH, 20));
    expect(line.startsWith("  ")).toBe(true);
    expect(line.includes(Glyph.chevron)).toBe(false);
  });

  it("truncates an overlong value to the remaining width", () => {
    const line = stripAnsi(renderPanelRowLine({ label: "x", value: "y".repeat(200) }, 40, 10));
    expect(stringWidth(line)).toBeLessThanOrEqual(40);
    expect(line.endsWith("…")).toBe(true);
  });

  it("places a pre-styled label verbatim and pads by the plain label width", () => {
    const styled =
      renderTextWithStyles("A", { color: Color.success }) +
      renderTextWithStyles("B", { color: Color.muted });
    const line = renderPanelRowLine({ label: "AB", styledLabel: styled, value: "v" }, WIDTH, 10);
    expect(line).toContain(styled);
    const plain = stripAnsi(line);
    expect(plain.startsWith("  AB")).toBe(true);
    // marker (2 cells) + 10-cell label column places the value at column 12.
    expect(plain.indexOf("v")).toBe(12);
  });
});

describe("renderListPanel", () => {
  const base: Omit<ListPanelSpec, "items" | "cursor"> = {
    title: "List",
    maxRows: 12,
  };

  it("shows overflow indicators when the list exceeds the window", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      label: `item ${index}`,
    }));
    const plain = renderListPanel({ ...base, items, cursor: 20 }, WIDTH).map(stripAnsi);
    expect(plain.some((line) => line.includes("more above"))).toBe(true);
    expect(plain.some((line) => line.includes("more below"))).toBe(true);
    // The selected item carries the chevron marker.
    expect(plain.some((line) => line.includes(`${Glyph.chevron}item 20`))).toBe(true);
  });

  it("renders the empty label with no rows", () => {
    const plain = renderListPanel(
      { ...base, items: [], cursor: 0, emptyLabel: "Nothing here." },
      WIDTH,
    ).map(stripAnsi);
    expect(plain.some((line) => line.includes("Nothing here."))).toBe(true);
  });

  it("reserves the prompt and status rows from a searchable command panel", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      label: `session ${index}`,
    }));
    const terminalRows = 34;
    const panel = renderListPanel(
      {
        command: "/resume",
        title: "Resume session",
        items,
        cursor: 50,
        maxRows: terminalRows,
        search: { query: "", placeholder: "Search…", focused: true },
        footerHints: [["Enter", "resume"]],
      },
      WIDTH,
    ).map(stripAnsi);
    expect(panel.length + 7).toBeLessThanOrEqual(terminalRows);
    expect(panel.some((line) => line.includes(`${Glyph.chevron}session 50`))).toBe(true);
  });
});
