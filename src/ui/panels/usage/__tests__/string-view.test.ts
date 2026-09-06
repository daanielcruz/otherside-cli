import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { dispatch } from "@/store/app-store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { createUsagePanel } from "@/ui/panels/usage/string-view.ts";
import { Color } from "@/ui/theme/theme.ts";

registerAllProviders();

const WIDTH = 80;

const originalColorLevel = chalk.level;

beforeAll(() => {
  chalk.level = 3;
  // Broker route seeded with placeholder values only — no real accounts.
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: {
      provider: "codex",
      model: "placeholder-model",
      effort: "high",
      fastMode: false,
      permissionMode: "default",
      orchestrationMode: "disabled",
      ultracode: false,
    },
  });
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

const tabRowOf = (panel: StringViewPanel): string => {
  const row = panel.render(WIDTH).find((line) => stripAnsi(line).includes(" General "));
  expect(row).toBeDefined();
  return row!;
};

// Panels stay unmounted: mount would load credentials/offline usage from disk,
// and none of the assertions need it (no ctx means the fallback row count).
describe("usage panel focus-model tabs", () => {
  it("renders the active chip in the header-focus style", () => {
    const panel = createUsagePanel(() => {});
    expect(tabRowOf(panel)).toContain(headerChip("General"));
  });

  it("cycles tabs on tab/left/right and keeps the chip styling", () => {
    const panel = createUsagePanel(() => {});
    panel.handleKey(key("right"));
    const row = tabRowOf(panel);
    expect(row).not.toContain(headerChip("General"));
    expect(stripAnsi(row)).toContain("General");

    panel.handleKey(key("tab", { shift: true, sequence: "\t" }));
    expect(tabRowOf(panel)).toContain(headerChip("General"));
  });

  it("closes on escape", () => {
    let closed = false;
    const panel = createUsagePanel(() => {
      closed = true;
    });
    panel.handleKey(key("escape"));
    expect(closed).toBe(true);
  });
});

describe("usage panel body budget", () => {
  it("clips the body to the terminal row budget with an overflow marker", () => {
    const panel = createUsagePanel(() => {});
    const lines = panel.render(WIDTH).map(stripAnsi);
    expect(lines.length).toBeLessThanOrEqual(FALLBACK_TERMINAL_ROWS);
    expect(lines.some((line) => line.includes("more"))).toBe(true);
  });
});
