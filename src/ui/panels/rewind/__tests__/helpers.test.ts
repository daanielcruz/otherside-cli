import { describe, expect, it } from "bun:test";
import {
  clampRewindIndex,
  numericConfirmationIndex,
  pageRewindIndex,
  visibleRewindRows,
} from "../index";

describe("rewind picker helpers", () => {
  it("derives visible picker rows from terminal height", () => {
    expect(visibleRewindRows(45)).toBe(5);
    expect(visibleRewindRows(12)).toBe(2);
  });

  it("clamps page movement at picker bounds", () => {
    expect(pageRewindIndex(4, 6, 1, 3)).toBe(5);
    expect(pageRewindIndex(1, 6, -1, 3)).toBe(0);
    expect(clampRewindIndex(2, 0)).toBe(0);
  });

  it("maps valid numeric confirmation choices only", () => {
    expect(numericConfirmationIndex("1", 4)).toBe(0);
    expect(numericConfirmationIndex("4", 4)).toBe(3);
    expect(numericConfirmationIndex("5", 4)).toBeNull();
    expect(numericConfirmationIndex("0", 4)).toBeNull();
  });
});
