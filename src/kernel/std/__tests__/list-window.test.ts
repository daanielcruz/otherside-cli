import { describe, expect, it } from "bun:test";
import { computeListWindow } from "../list-window.ts";

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
