import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { createConfigPanel } from "../string-view.ts";

const WIDTH = 80;
/** SGR 7 — the reverse-video introducer of the active-but-unfocused chip. */
const REVERSE_VIDEO = "\x1b[7m";
/** The SGR opener a style renders with, without re-deriving frame geometry. */
const sgrOpenFor = (styles: Parameters<typeof renderTextWithStyles>[1]): string => {
  const rendered = renderTextWithStyles("x", styles);
  return rendered.slice(0, rendered.indexOf("x"));
};

const HEADER_HINTS = "←/→/tab to switch · ↓ to return · Esc to close";
const SEARCH_HINTS = "Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear";
const LIST_HINTS = "Enter/Space to change · / to search · Esc to close";
const DETAILS_HINTS = "←/→/tab to switch · Esc to close";

const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

const press = (panel: StringViewPanel, ...keys: KeyEventData[]): void => {
  for (const event of keys) panel.handleKey(event);
};

/** The active chip in each focus state of the shared chrome contract. */
const chip = (label: string, focus: "header" | "content"): string =>
  focus === "header"
    ? renderTextWithStyles(` ${label} `, {
        bold: true,
        backgroundColor: Color.panelAccent,
        color: Color.tabSelectedText,
      })
    : renderTextWithStyles(` ${label} `, { bold: true, inverse: true });

const tabRowOf = (panel: StringViewPanel): string => {
  const row = panel.render(WIDTH).find((line) => stripAnsi(line).includes(" Details "));
  expect(row).toBeDefined();
  return row!;
};

const hintLineOf = (panel: StringViewPanel): string => {
  const lines = panel.render(WIDTH);
  return stripAnsi(lines.at(-2)!).trim();
};

const searchBoxShows = (panel: StringViewPanel, text: string): boolean =>
  panel.render(WIDTH).some((line) => stripAnsi(line).includes(`${Glyph.search} ${text}`));

describe("config panel focus model", () => {
  it("opens with search focused and the active chip in reverse-video", () => {
    const panel = createConfigPanel(() => {});
    const tabRow = tabRowOf(panel);
    expect(tabRow).toContain(chip("Config", "content"));
    expect(tabRow).toContain(REVERSE_VIDEO);
    expect(tabRow).not.toContain(chip("Config", "header"));
    expect(panel.render(WIDTH).join("\n")).toContain(
      "  " + sgrOpenFor({ color: Color.panelAccent }) + Glyph.boxTopLeft,
    );
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);
  });

  it("opens the details tab with the header focused when search is absent", () => {
    const panel = createConfigPanel(() => {}, { initialTab: "details" });
    expect(tabRowOf(panel)).toContain(chip("Details", "header"));
    expect(hintLineOf(panel)).toBe(DETAILS_HINTS);
  });

  it("moves focus between search and header on up/down and recolors the chip", () => {
    const panel = createConfigPanel(() => {});
    press(panel, key("up"));
    const headerRow = tabRowOf(panel);
    expect(headerRow).toContain(chip("Config", "header"));
    expect(headerRow).not.toContain(REVERSE_VIDEO);
    expect(hintLineOf(panel)).toBe(HEADER_HINTS);

    press(panel, key("down"));
    expect(tabRowOf(panel)).toContain(chip("Config", "content"));
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);
  });

  it("cycles tabs on tab/left/right only while the header holds focus", () => {
    const panel = createConfigPanel(() => {});
    press(panel, key("tab", { sequence: "\t" }));
    expect(tabRowOf(panel)).toContain(chip("Config", "content"));
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);

    press(panel, key("up"), key("tab", { sequence: "\t" }));
    expect(tabRowOf(panel)).toContain(chip("Details", "header"));
    expect(hintLineOf(panel)).toBe(DETAILS_HINTS);

    press(panel, key("right"));
    expect(tabRowOf(panel)).toContain(chip("Config", "header"));
    press(panel, key("left"));
    expect(tabRowOf(panel)).toContain(chip("Details", "header"));
  });
});

describe("config panel search machine", () => {
  it("hands focus to the list on enter and shows the row-action hints", () => {
    const panel = createConfigPanel(() => {});
    press(panel, key("return"));
    expect(hintLineOf(panel)).toBe(LIST_HINTS);
  });

  it("re-enters on slash, types into the query, and walks the Esc ladder to close", () => {
    let closed = false;
    const panel = createConfigPanel(() => {
      closed = true;
    });
    press(panel, key("return"));
    expect(hintLineOf(panel)).toBe(LIST_HINTS);

    press(panel, key("/", { sequence: "/" }));
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);
    press(panel, key("l", { sequence: "l" }), key("a", { sequence: "a" }));
    expect(searchBoxShows(panel, "la")).toBe(true);

    press(panel, key("escape"));
    expect(searchBoxShows(panel, "la")).toBe(false);
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);

    press(panel, key("escape"));
    expect(hintLineOf(panel)).toBe(LIST_HINTS);
    expect(closed).toBe(false);

    press(panel, key("escape"));
    expect(closed).toBe(true);
  });

  it("closes from the header on escape", () => {
    let closed = false;
    const panel = createConfigPanel(() => {
      closed = true;
    });
    press(panel, key("up"), key("escape"));
    expect(closed).toBe(true);
  });
});

describe("config panel jumps and half-page scrolling", () => {
  const tallPanel = (): StringViewPanel => {
    const panel = createConfigPanel(() => {});
    panel.mount?.({
      requestRender: () => {},
      pushFocus: () => {},
      popFocus: () => {},
      terminalRows: () => 40,
    });
    return panel;
  };

  /** The row the cursor sits on; only the selected row's label is bold and lit. */
  const selectedRowOf = (panel: StringViewPanel): string => {
    const open = sgrOpenFor({ color: Color.panelAccent, bold: true });
    const line = panel.render(WIDTH).find((row) => row.includes(open));
    return stripAnsi(line ?? "").trim();
  };

  it("reaches the tabs by letter from the list, and comes back the same way", () => {
    const panel = tallPanel();
    press(panel, key("return"));
    expect(hintLineOf(panel)).toBe(LIST_HINTS);

    press(panel, key("d", { sequence: "d" }));
    expect(tabRowOf(panel)).toContain(chip("Details", "header"));
    expect(hintLineOf(panel)).toBe(DETAILS_HINTS);

    press(panel, key("c", { sequence: "c" }));
    expect(tabRowOf(panel)).toContain(chip("Config", "content"));
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);
  });

  it("keeps the letters in the query while the search box holds focus", () => {
    const panel = tallPanel();
    press(panel, key("d", { sequence: "d" }));
    expect(searchBoxShows(panel, "d")).toBe(true);
    expect(tabRowOf(panel)).toContain(chip("Config", "content"));
  });

  it("moves the row cursor by half a page on ctrl+d and back on ctrl+u", () => {
    const stepper = tallPanel();
    press(stepper, key("return"));
    const first = selectedRowOf(stepper);
    press(stepper, key("down"));
    const oneDown = selectedRowOf(stepper);

    const pager = tallPanel();
    press(pager, key("return"));
    expect(selectedRowOf(pager)).toBe(first);

    press(pager, key("d", { ctrl: true }));
    const halfDown = selectedRowOf(pager);
    expect(halfDown).not.toBe(first);
    expect(halfDown).not.toBe(oneDown);

    press(pager, key("u", { ctrl: true }));
    expect(selectedRowOf(pager)).toBe(first);
  });

  it("leaves the half-page keys alone while the search box holds focus", () => {
    const panel = tallPanel();
    press(panel, key("d", { ctrl: true }));
    expect(hintLineOf(panel)).toBe(SEARCH_HINTS);
    expect(searchBoxShows(panel, "d")).toBe(false);
  });
});
