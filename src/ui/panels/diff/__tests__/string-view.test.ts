import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { createDiffPanel, type DiffSnapshot } from "@/ui/panels/diff/string-view.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color } from "@/ui/theme/theme.ts";

const WIDTH = 80;

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

/** The active chip while the header holds focus — the exact SGR the chrome emits. */
const headerChip = (label: string): string =>
  renderTextWithStyles(` ${label} `, {
    bold: true,
    backgroundColor: Color.panelAccent,
    color: Color.tabSelectedText,
  });

/** A placeholder snapshot so tests never spawn git or read a real working tree. */
const snapshot = (patchLines: number): DiffSnapshot => ({
  ok: true,
  branch: "placeholder-branch",
  status: ["M placeholder.ts"],
  stat: ["placeholder.ts | 2 +-"],
  patch: Array.from({ length: patchLines }, (_, row) => `+patch line ${row}`),
});

const mountedPanel = (patchLines: number, terminalRows: () => number): StringViewPanel => {
  const panel = createDiffPanel(() => {}, { snapshot: snapshot(patchLines) });
  panel.mount?.({ requestRender() {}, pushFocus() {}, popFocus() {}, terminalRows });
  return panel;
};

const tabRowOf = (panel: StringViewPanel): string => {
  const row = panel.render(WIDTH).find((line) => stripAnsi(line).includes(" Summary "));
  expect(row).toBeDefined();
  return row!;
};

describe("diff panel focus-model tabs", () => {
  it("renders the active chip in the header-focus style", () => {
    const panel = mountedPanel(4, () => 30);
    expect(tabRowOf(panel)).toContain(headerChip("Summary"));
    expect(tabRowOf(panel)).not.toContain(headerChip("Patch"));
  });

  it("cycles tabs on tab/left/right with wrap-around", () => {
    const panel = mountedPanel(4, () => 30);
    panel.handleKey(key("tab", { sequence: "\t" }));
    expect(tabRowOf(panel)).toContain(headerChip("Patch"));

    panel.handleKey(key("right"));
    expect(tabRowOf(panel)).toContain(headerChip("Summary"));

    panel.handleKey(key("left"));
    expect(tabRowOf(panel)).toContain(headerChip("Patch"));
  });
});

describe("diff panel body window", () => {
  it("keeps the frame inside the terminal row budget", () => {
    const panel = mountedPanel(120, () => 20);
    panel.handleKey(key("right")); // Patch tab
    const lines = panel.render(WIDTH).map(stripAnsi);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.some((line) => line.includes("patch line 0"))).toBe(true);
    expect(lines.some((line) => line.includes("patch line 119"))).toBe(false);
  });

  it("scrolls by line and clamps at the end of the patch", () => {
    const panel = mountedPanel(12, () => 18);
    panel.handleKey(key("right")); // Patch tab
    for (let step = 0; step < 100; step++) panel.handleKey(key("down"));
    const lines = panel.render(WIDTH).map(stripAnsi);
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.some((line) => line.includes("patch line 11"))).toBe(true);
    expect(lines.some((line) => line.endsWith("patch line 0"))).toBe(false);
  });
});

/** First visible patch row of the current frame, as its line index. */
const firstPatchRow = (panel: StringViewPanel): number => {
  const row = panel
    .render(WIDTH)
    .map(stripAnsi)
    .find((line) => line.includes("patch line "));
  expect(row).toBeDefined();
  return Number(row!.trim().replace(/^\+patch line /, ""));
};

describe("diff panel paging", () => {
  it("pages down by half the visible body and back up to the same row", () => {
    const panel = mountedPanel(200, () => 30);
    panel.handleKey(key("right")); // Patch tab
    expect(firstPatchRow(panel)).toBe(0);

    panel.handleKey(key("pagedown"));
    const afterPage = firstPatchRow(panel);
    expect(afterPage).toBeGreaterThan(1);

    panel.handleKey(key("pageup"));
    expect(firstPatchRow(panel)).toBe(0);
  });

  it("moves a whole page further than a single line step", () => {
    const panel = mountedPanel(200, () => 30);
    panel.handleKey(key("right"));
    panel.handleKey(key("down"));
    const afterLine = firstPatchRow(panel);

    const paged = mountedPanel(200, () => 30);
    paged.handleKey(key("right"));
    paged.render(WIDTH); // resolve the geometry a page is measured against
    paged.handleKey(key("pagedown"));
    expect(firstPatchRow(paged)).toBeGreaterThan(afterLine);
  });

  it("jumps to the end and home returns to the first row", () => {
    const panel = mountedPanel(200, () => 30);
    panel.handleKey(key("right"));
    panel.render(WIDTH);

    panel.handleKey(key("end"));
    const lines = panel.render(WIDTH).map(stripAnsi);
    expect(lines.some((line) => line.includes("patch line 199"))).toBe(true);
    expect(lines.some((line) => line.includes("patch line 0 "))).toBe(false);

    panel.handleKey(key("home"));
    expect(firstPatchRow(panel)).toBe(0);
  });

  it("holds at the top when a page up runs off the start", () => {
    const panel = mountedPanel(200, () => 30);
    panel.handleKey(key("right"));
    panel.render(WIDTH);
    panel.handleKey(key("pageup"));
    panel.handleKey(key("pageup"));
    expect(firstPatchRow(panel)).toBe(0);
  });
});
