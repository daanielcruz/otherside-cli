import { describe, expect, test } from "bun:test";
import { isOverlayName, OVERLAY_NAMES } from "../registry";

describe("panel registry", () => {
  test("recognizes every registered overlay name", () => {
    for (const name of OVERLAY_NAMES) {
      expect(isOverlayName(name)).toBe(true);
    }
  });

  test("rejects unknown overlay names", () => {
    expect(isOverlayName("missing-panel")).toBe(false);
  });
});
