import { describe, expect, it, test } from "bun:test";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  type FooterPanelSpec,
  labelColumnWidth,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";

const WIDTH = 80;

function spec(body: string[], maxRows?: number): FooterPanelSpec {
  return {
    command: "/mcp",
    footerHints: [["Esc", "back"]],
    ...(maxRows === undefined ? {} : { maxRows }),
    body,
  };
}

describe("footer panel height budget", () => {
  it("emits the whole body when no budget is given", () => {
    const body = Array.from({ length: 60 }, (_, row) => `detail row ${row}`);
    const rows = renderFooterPanel(spec(body), WIDTH).map(stripAnsi);

    expect(rows.filter((row) => row.includes("detail row"))).toHaveLength(60);
    expect(rows.some((row) => row.includes("more"))).toBe(false);
  });

  it("keeps the frame inside its budget and says how much it held back", () => {
    const body = Array.from({ length: 60 }, (_, row) => `detail row ${row}`);
    const rows = renderFooterPanel(spec(body, 30), WIDTH).map(stripAnsi);

    expect(rows.length).toBeLessThanOrEqual(30);
    // The frame survives: its command bar and footer hint are still on screen.
    expect(rows.some((row) => row.includes("/mcp"))).toBe(true);
    expect(rows.some((row) => row.includes("back"))).toBe(true);
    const overflow = rows.find((row) => row.includes("more"));
    expect(overflow).toBeDefined();
    expect(overflow).toContain("↓");
  });

  it("still shows a line of body when the budget is far too small", () => {
    const rows = renderFooterPanel(spec(["a", "b", "c", "d"], 8), WIDTH).map(stripAnsi);

    expect(rows.some((row) => row.includes("a"))).toBe(true);
    expect(rows.some((row) => row.includes("more"))).toBe(true);
  });
});

describe("a frame whose hints wrap", () => {
  const HINTS: [string, string][] = [
    ["↑↓", "navigate"],
    ["PgUp/PgDn", "page"],
    ["Enter", "open"],
    ["Space", "toggle"],
    ["/", "search"],
    ["Esc", "close"],
  ];

  function hintedSpec(rows: number): FooterPanelSpec {
    return {
      command: "/plugins",
      title: "Plugins",
      footerHints: HINTS,
      maxRows: rows,
      body: Array.from({ length: 40 }, (_, row) => `detail row ${row}`),
    };
  }

  test.each([120, 60, 40])("stays inside its budget at %i columns", (width) => {
    // The hints wrap onto more rows as the frame narrows, and a frame that counted
    // them as one would spend the shell's rows on its own body.
    const rows = renderFooterPanel(hintedSpec(24), width);
    expect(rows.length).toBeLessThanOrEqual(24);
  });

  test("gives the body back what the wrapping hints took, and no more", () => {
    // The rows have to come from somewhere: a narrower frame spends more of them
    // on hints, so the body gets fewer — while the frame's height does not move.
    const frames = [120, 60, 40].map((width) =>
      renderFooterPanel(hintedSpec(24), width).map(stripAnsi),
    );
    const heights = frames.map((frame) => frame.length);
    const bodies = frames.map((frame) => frame.filter((row) => row.includes("detail row")).length);

    expect(new Set(heights).size).toBe(1);
    expect(bodies[0]).toBeGreaterThan(bodies[1] ?? 0);
    expect(bodies[1]).toBeGreaterThan(bodies[2] ?? 0);
  });
});

describe("the column a list's values start at", () => {
  test("is the widest label plus a gap, so short lists sit tight", () => {
    expect(labelColumnWidth(["Provider", "Model"])).toBe(12);
    expect(labelColumnWidth(["Default permission mode", "Model"])).toBe(27);
  });

  test("counts what a label occupies on screen, not how many characters it has", () => {
    // A wide glyph takes two columns, and a column that counted it as one would
    // put the value a column early on exactly the row that set the width.
    expect(labelColumnWidth(["日本語"])).toBe(10);
  });

  test("is the gap alone when there is nothing to measure", () => {
    expect(labelColumnWidth([])).toBe(4);
  });
});
