import { describe, expect, it } from "bun:test";
import { isColorValue, parseColorValue } from "@/ui/theme/custom/color-value.ts";

describe("color value notations", () => {
  it("takes each of the four notations the prompt advertises", () => {
    expect(parseColorValue("#3EA0C3")).toBe("#3EA0C3");
    expect(parseColorValue("rgb(10,20,30)")).toBe("rgb(10,20,30)");
    expect(parseColorValue("ansi256(42)")).toBe("ansi256(42)");
    expect(parseColorValue("ansi:blue")).toBe("ansi:blue");
  });

  it("reads hex in either case, and only at six digits", () => {
    expect(parseColorValue("#3ea0c3")).toBe("#3ea0c3");
    expect(parseColorValue("#3EA0C")).toBeUndefined();
    expect(parseColorValue("#3EA0C3F0")).toBeUndefined();
    expect(parseColorValue("3EA0C3")).toBeUndefined();
  });

  it("takes every ansi name the style model carries, and no other", () => {
    expect(parseColorValue("ansi:redBright")).toBe("ansi:redBright");
    expect(parseColorValue("ansi:whiteBright")).toBe("ansi:whiteBright");
    expect(parseColorValue("ansi:RED")).toBeUndefined();
    expect(parseColorValue("ansi:notarealname")).toBeUndefined();
  });

  it("checks the notation rather than the magnitude", () => {
    // The terminal clamps an oversized channel, so refusing it here would reject
    // a value that still paints.
    expect(parseColorValue("rgb(300,300,300)")).toBe("rgb(300,300,300)");
    expect(parseColorValue("ansi256(999)")).toBe("ansi256(999)");
    expect(parseColorValue("ansi256(0)")).toBe("ansi256(0)");
  });

  it("refuses a negative channel and a wrong component count", () => {
    expect(parseColorValue("rgb(-1,0,0)")).toBeUndefined();
    expect(parseColorValue("ansi256(-5)")).toBeUndefined();
    expect(parseColorValue("rgb(1,2)")).toBeUndefined();
    expect(parseColorValue("rgb(1,2,3,4)")).toBeUndefined();
  });

  it("refuses free text and an empty field", () => {
    expect(parseColorValue("notacolor")).toBeUndefined();
    expect(parseColorValue("")).toBeUndefined();
    expect(parseColorValue("   ")).toBeUndefined();
    expect(isColorValue("notacolor")).toBe(false);
    expect(isColorValue("#FF0000")).toBe(true);
  });

  it("ignores the whitespace around a value", () => {
    expect(parseColorValue("  #FF0000  ")).toBe("#FF0000");
    expect(parseColorValue("rgb( 1 , 2 , 3 )")).toBe("rgb(1,2,3)");
  });
});
