import { describe, expect, it } from "bun:test";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { renderSplitPane, SPLIT_PANE_MIN_WIDTH, splitPaneWidths } from "@/ui/chrome/split-pane.ts";

const LEFT_WIDTH = 16;

function pane(frameWidth: number, height: number, rows: { left: string[]; right: string[] }) {
  const widths = splitPaneWidths(frameWidth, LEFT_WIDTH);
  if (widths === null) throw new Error("expected a split at this width");
  return renderSplitPane({
    left: { title: "Phases", rows: rows.left, width: widths.left },
    right: { title: "Sleep A · 2 agents", rows: rows.right, width: widths.right },
    height,
  }).map(stripAnsi);
}

describe("the split pane's geometry", () => {
  it("draws every row at the frame's exact width", () => {
    const lines = pane(100, 6, { left: ["1 Sleep A"], right: ["sleep-a-1"] });

    for (const line of lines) expect(stringWidth(line)).toBe(100);
  });

  it("keeps the box open for its full height even where no content reaches", () => {
    const lines = pane(100, 8, { left: ["only row"], right: [] });

    // Two rules plus the interior; a short column pads rather than closing early.
    expect(lines).toHaveLength(10);
    expect(lines[9]).toStartWith("╰");
    for (const interior of lines.slice(1, 9)) {
      expect(interior).toStartWith("│");
      expect(interior).toEndWith("│");
    }
  });

  it("insets each title into the top rule and joins the columns", () => {
    const [top] = pane(100, 2, { left: [], right: [] });

    expect(top).toStartWith("╭ Phases ─");
    expect(top).toContain("┬ Sleep A · 2 agents ─");
    expect(top).toEndWith("╮");
  });

  it("closes the bottom rule with the matching join", () => {
    const lines = pane(100, 2, { left: [], right: [] });
    const bottom = lines[lines.length - 1] ?? "";

    expect(bottom).toStartWith("╰─");
    expect(bottom).toContain("┴");
    expect(bottom).toEndWith("╯");
  });

  it("truncates a title rather than letting it push the rule past its column", () => {
    const widths = splitPaneWidths(100, LEFT_WIDTH);
    if (widths === null) throw new Error("expected a split");
    const lines = renderSplitPane({
      left: { title: "a title far wider than its own column", rows: [], width: widths.left },
      right: { title: "right", rows: [], width: widths.right },
      height: 1,
    }).map(stripAnsi);

    for (const line of lines) expect(stringWidth(line)).toBe(100);
  });

  it("truncates a row that overruns its column", () => {
    const lines = pane(100, 2, { left: ["a left row wider than sixteen cells"], right: [] });

    for (const line of lines) expect(stringWidth(line)).toBe(100);
    expect(lines[1]).toContain("…");
  });
});

describe("the split pane's width gate", () => {
  it("splits at the minimum width and refuses below it", () => {
    expect(splitPaneWidths(SPLIT_PANE_MIN_WIDTH, LEFT_WIDTH)).not.toBeNull();
    expect(splitPaneWidths(SPLIT_PANE_MIN_WIDTH - 1, LEFT_WIDTH)).toBeNull();
  });

  it("refuses when the left column leaves the right with nothing", () => {
    expect(splitPaneWidths(80, 80)).toBeNull();
  });

  it("gives the right column every cell the left and the borders do not take", () => {
    const widths = splitPaneWidths(100, LEFT_WIDTH);

    expect(widths).toEqual({ left: 16, right: 77 });
  });
});
