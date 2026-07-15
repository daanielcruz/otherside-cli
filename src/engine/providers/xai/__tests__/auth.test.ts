import { describe, expect, test } from "bun:test";
import { expiresMsFor } from "@/engine/providers/xai/auth.ts";

const FIVE_MIN = 5 * 60 * 1000;

describe("expiresMsFor", () => {
  test("caps the device poll at 5 minutes even when the server allows longer", () => {
    // auth.x.ai returns expires_in=1800 (30 min); an abandoned poll must stop at 5.
    expect(expiresMsFor(1800)).toBe(FIVE_MIN);
    expect(expiresMsFor(600)).toBe(FIVE_MIN);
  });

  test("honors a shorter server window under the cap", () => {
    expect(expiresMsFor(120)).toBe(120_000);
  });

  test("falls back to the cap when expires_in is missing or invalid", () => {
    expect(expiresMsFor(undefined)).toBe(FIVE_MIN);
    expect(expiresMsFor(0)).toBe(FIVE_MIN);
    expect(expiresMsFor(-5)).toBe(FIVE_MIN);
  });
});
