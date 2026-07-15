import { describe, expect, it } from "bun:test";
import { integerFromStringOrUndefined } from "../value-guards.ts";

describe("integerFromStringOrUndefined", () => {
  it("returns integer numbers unchanged", () => {
    expect(integerFromStringOrUndefined(42)).toBe(42);
    expect(integerFromStringOrUndefined(-7)).toBe(-7);
    expect(integerFromStringOrUndefined(0)).toBe(0);
    expect(integerFromStringOrUndefined(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parses numeric strings to integers including trimmed whitespace", () => {
    expect(integerFromStringOrUndefined("42")).toBe(42);
    expect(integerFromStringOrUndefined("  42  ")).toBe(42);
    expect(integerFromStringOrUndefined("-7")).toBe(-7);
    expect(integerFromStringOrUndefined("0")).toBe(0);
    expect(integerFromStringOrUndefined("\t123\n")).toBe(123);
  });

  it("rejects non-numeric and non-integer strings", () => {
    expect(integerFromStringOrUndefined("abc")).toBeUndefined();
    expect(integerFromStringOrUndefined("3.14")).toBeUndefined();
    expect(integerFromStringOrUndefined("")).toBeUndefined();
    expect(integerFromStringOrUndefined("   ")).toBeUndefined();
    expect(integerFromStringOrUndefined("42abc")).toBeUndefined();
  });

  it("rejects booleans and null", () => {
    expect(integerFromStringOrUndefined(true)).toBeUndefined();
    expect(integerFromStringOrUndefined(false)).toBeUndefined();
    expect(integerFromStringOrUndefined(null)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(integerFromStringOrUndefined(undefined)).toBeUndefined();
  });
});
