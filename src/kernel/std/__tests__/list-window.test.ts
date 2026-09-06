import { describe, expect, it } from "bun:test";
import {
  computeItemCountWindow,
  computeListWindow,
  computeRowBudgetWindow,
  terminalRowBudget,
} from "../list-window.ts";

describe("computeListWindow edge anchor", () => {
  const cases = [
    {
      name: "moves the window up when the cursor is above it",
      input: { cursor: 2, total: 10, size: 3, anchor: "edge" as const, previousStart: 4 },
      expected: { from: 2, to: 5, size: 3, above: 2, below: 5 },
    },
    {
      name: "moves the window down when the cursor is below it",
      input: { cursor: 8, total: 10, size: 3, anchor: "edge" as const, previousStart: 4 },
      expected: { from: 6, to: 9, size: 3, above: 6, below: 1 },
    },
    {
      name: "retains the prior start when the cursor is inside it",
      input: { cursor: 5, total: 10, size: 3, anchor: "edge" as const, previousStart: 4 },
      expected: { from: 4, to: 7, size: 3, above: 4, below: 3 },
    },
    {
      name: "clamps the prior start after the list shrinks",
      input: { cursor: -1, total: 5, size: 3, anchor: "edge" as const, previousStart: 7 },
      expected: { from: 2, to: 5, size: 3, above: 2, below: 0 },
    },
    {
      name: "preserves the prior start for a zero-sized window",
      input: { cursor: 3, total: 10, size: 0, anchor: "edge" as const, previousStart: 4 },
      expected: { from: 4, to: 4, size: 0, above: 4, below: 6 },
    },
    {
      name: "shows the full list when it is smaller than the window",
      input: { cursor: 1, total: 3, size: 5, anchor: "edge" as const, previousStart: 2 },
      expected: { from: 0, to: 3, size: 5, above: 0, below: 0 },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(computeListWindow(input)).toEqual(expected);
    });
  }
});

describe("computeItemCountWindow", () => {
  it("shows the full list without markers when it fits", () => {
    const window = computeItemCountWindow({ cursor: 1, total: 3, visibleCount: 5 });
    expect(window.from).toBe(0);
    expect(window.to).toBe(3);
    expect(window.markerAbove).toBeUndefined();
    expect(window.markerBelow).toBeUndefined();
    expect(window.counter).toBe("(2/3)");
  });

  it("keeps the anchored start and marks both hidden sides without counts", () => {
    const window = computeItemCountWindow({
      cursor: 5,
      total: 10,
      visibleCount: 3,
      previousStart: 4,
    });
    expect(window.from).toBe(4);
    expect(window.to).toBe(7);
    expect(window.markerAbove).toBe(" ↑ more above");
    expect(window.markerBelow).toBe(" ↓ more below");
    expect(window.counter).toBe("(6/10)");
  });

  it("drops the below marker at the end of the list", () => {
    const window = computeItemCountWindow({ cursor: 9, total: 10, visibleCount: 3 });
    expect(window.from).toBe(7);
    expect(window.markerAbove).toBe(" ↑ more above");
    expect(window.markerBelow).toBeUndefined();
  });
});

describe("terminalRowBudget", () => {
  it("derives the budget from the terminal and clamps between floor and cap", () => {
    const bounds = { reservedRows: 10, floorRows: 4, capRows: 20 };
    expect(terminalRowBudget({ terminalRows: 24, ...bounds })).toBe(14);
    expect(terminalRowBudget({ terminalRows: 12, ...bounds })).toBe(4);
    expect(terminalRowBudget({ terminalRows: 60, ...bounds })).toBe(20);
  });
});

describe("computeRowBudgetWindow", () => {
  it("shows everything without markers when the rows fit", () => {
    expect(computeRowBudgetWindow({ cursor: 0, itemRows: [1, 1, 1], budgetRows: 5 })).toEqual({
      from: 0,
      to: 3,
      above: 0,
      below: 0,
      markerAbove: undefined,
      markerBelow: undefined,
    });
  });

  it("charges a marker row below and counts the hidden items", () => {
    const window = computeRowBudgetWindow({
      cursor: 0,
      itemRows: [1, 1, 1, 1, 1, 1],
      budgetRows: 4,
    });
    expect(window).toEqual({
      from: 0,
      to: 3,
      above: 0,
      below: 3,
      markerAbove: undefined,
      markerBelow: "↓ 3 more below",
    });
  });

  it("slides until the cursor fits, marking both sides with counts", () => {
    const window = computeRowBudgetWindow({
      cursor: 3,
      itemRows: [1, 1, 1, 1, 1, 1],
      budgetRows: 4,
      previousStart: 0,
    });
    expect(window).toEqual({
      from: 2,
      to: 4,
      above: 2,
      below: 2,
      markerAbove: "↑ 2 more above",
      markerBelow: "↓ 2 more below",
    });
  });

  it("charges variable item heights against the budget", () => {
    const window = computeRowBudgetWindow({
      cursor: 2,
      itemRows: [2, 3, 2],
      budgetRows: 5,
      previousStart: 0,
    });
    expect(window.from).toBe(2);
    expect(window.to).toBe(3);
    expect(window.markerAbove).toBe("↑ 2 more above");
    expect(window.markerBelow).toBeUndefined();
  });

  it("keeps a cursor item taller than the budget visible", () => {
    const window = computeRowBudgetWindow({ cursor: 1, itemRows: [1, 10, 1], budgetRows: 4 });
    expect(window.from).toBe(1);
    expect(window.to).toBe(2);
    expect(window.above).toBe(1);
    expect(window.below).toBe(1);
  });
});
