import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { createThemePanel } from "@/ui/panels/theme/string-view.ts";
import {
  isSyntaxHighlightingEnabled,
  setSyntaxHighlightingEnabled,
} from "@/ui/theme/syntax-highlighting.ts";
import { Glyph, getActiveThemeName, setActiveTheme, type ThemeName } from "@/ui/theme/theme.ts";

const WIDTH = 80;

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
  terminalRows: () => 40,
};

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

const letter = (char: string): KeyEventData => key(char, { sequence: char });
const digit = (char: string): KeyEventData => key("number", { sequence: char });

let previousConfigDir: string | undefined;
let configDir: string;
let baselineTheme: ThemeName = "dark";

beforeAll(() => {
  baselineTheme = getActiveThemeName();
});

afterAll(() => {
  setActiveTheme(baselineTheme);
});

beforeEach(() => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-theme-panel-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

function mounted(onClose: () => void = () => {}): StringViewPanel {
  const panel = createThemePanel(onClose);
  panel.mount?.(ctx);
  return panel;
}

/** The row the cursor points at; the picker marks it with the chevron. */
function selectedRow(panel: StringViewPanel): string {
  const row = panel
    .render(WIDTH)
    .map(stripAnsi)
    .find((line) => line.trimStart().startsWith(Glyph.chevron));
  return (row ?? "").replace(Glyph.chevron, "").trim();
}

describe("theme picker list keys", () => {
  it("steps with j/k the way it steps with the arrows", () => {
    const panel = mounted();
    const first = selectedRow(panel);

    panel.handleKey(letter("j"));
    const afterJ = selectedRow(panel);
    expect(afterJ).not.toBe(first);

    panel.handleKey(letter("k"));
    expect(selectedRow(panel)).toBe(first);

    panel.handleKey(key("down"));
    expect(selectedRow(panel)).toBe(afterJ);
    panel.unmount?.();
  });

  it("reaches both ends with home/end", () => {
    const panel = mounted();
    panel.handleKey(key("end"));
    // The create row sits below every palette, so it is what End reaches.
    expect(selectedRow(panel)).toContain("New custom theme");

    panel.handleKey(key("home"));
    expect(selectedRow(panel)).toContain("Auto");
    panel.unmount?.();
  });

  it("takes the nth theme on its digit and closes", () => {
    let closed = false;
    const panel = mounted(() => {
      closed = true;
    });

    panel.handleKey(digit("3"));

    expect(closed).toBe(true);
    expect(getActiveThemeName()).toBe("light");
    panel.unmount?.();
  });

  it("names selecting and cancelling in the footer", () => {
    const panel = mounted();
    expect(panel.render(WIDTH).map(stripAnsi).join("\n")).toContain(
      "Enter to select · Esc to cancel",
    );
    panel.unmount?.();
  });
});

describe("theme picker rows", () => {
  it("numbers each row and reads it as a sentence", () => {
    const panel = mounted();
    const text = panel.render(WIDTH).map(stripAnsi).join("\n");

    expect(text).toContain("1. Auto (match terminal)");
    expect(text).toContain("4. Dark mode (colorblind-friendly)");
    expect(text).toContain("6. Dark mode (ANSI colors only)");
    expect(text).toContain("8. New custom theme…");
    panel.unmount?.();
  });

  /**
   * The two marks answer different questions, so moving the cursor must not move
   * the check — browsing previews a palette, and only Enter puts one in force.
   */
  it("keeps the check on the palette in force while the cursor moves", () => {
    setActiveTheme("dark");
    const panel = mounted();
    const checked = (): string =>
      panel
        .render(WIDTH)
        .map(stripAnsi)
        .find((line) => line.includes(Glyph.check)) ?? "";
    const before = checked();

    panel.handleKey(key("down"));
    panel.handleKey(key("down"));

    expect(checked()).toBe(before);
    expect(selectedRow(panel)).not.toContain(Glyph.check);
    panel.unmount?.();
  });
});

describe("the theme sample", () => {
  const sampleOf = (panel: StringViewPanel): string =>
    panel.render(WIDTH).map(stripAnsi).join("\n");

  it("shows a worked diff between two rules", () => {
    const panel = mounted();
    const text = sampleOf(panel);

    expect(text).toContain("function greet() {");
    expect(text).toContain('console.log("Hello, otherside!");');
    expect(text.split("\n").filter((line) => line.includes("╌╌╌"))).toHaveLength(2);
    panel.unmount?.();
  });

  it("names the scheme the palette under the cursor colours code with", () => {
    setActiveTheme("dark");
    const panel = mounted();
    expect(sampleOf(panel)).toContain("Syntax theme: Monokai (ctrl+t to disable)");

    // Row 3 is the light palette, which resolves a different scheme.
    panel.handleKey(key("home"));
    panel.handleKey(key("down"));
    panel.handleKey(key("down"));

    expect(sampleOf(panel)).toContain("Syntax theme: GitHub (ctrl+t to disable)");
    panel.unmount?.();
  });

  it("says what the toggle does next once colouring is off", () => {
    const wasEnabled = isSyntaxHighlightingEnabled();
    const panel = mounted();
    try {
      panel.handleKey(key("t", { ctrl: true }));
      expect(sampleOf(panel)).toContain("Syntax highlighting disabled (ctrl+t to enable)");
    } finally {
      // Held for the whole process, so a test that flips it owes it back.
      setSyntaxHighlightingEnabled(wasEnabled);
      panel.unmount?.();
    }
  });
});
