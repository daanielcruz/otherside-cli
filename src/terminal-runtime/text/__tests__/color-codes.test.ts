import { afterEach, describe, expect, it } from "bun:test";
import type { AnsiCode } from "@alcalzone/ansi-tokenize";
import chalk from "chalk";
import {
  downsampleTruecolorCodes,
  rgbToAnsi256,
  terminalAdvertisesTruecolor,
} from "@/terminal-runtime/text/color-codes.js";

const originalLevel = chalk.level;

afterEach(() => {
  chalk.level = originalLevel;
});

function ansi(code: string, endCode: string): AnsiCode {
  return { type: "ansi", code, endCode };
}

describe("terminalAdvertisesTruecolor", () => {
  it("recognizes standard color-term hints", () => {
    expect(terminalAdvertisesTruecolor({ COLORTERM: "truecolor" })).toBe(true);
    expect(terminalAdvertisesTruecolor({ COLORTERM: "24bit" })).toBe(true);
    expect(terminalAdvertisesTruecolor({ TERM: "xterm-direct" })).toBe(true);
  });

  it("does not upgrade an ordinary 256-color terminal", () => {
    expect(terminalAdvertisesTruecolor({ TERM: "screen-256color" })).toBe(false);
  });
});

describe("rgbToAnsi256", () => {
  it("maps near-black to the cube floor", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
    expect(rgbToAnsi256(4, 4, 4)).toBe(16);
  });

  it("maps bright balanced white to the cube top, not the gray ramp", () => {
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
  });

  it("maps a saturated color to its 6×6×6 cube index", () => {
    expect(rgbToAnsi256(215, 119, 87)).toBe(173);
  });

  it("prefers the grayscale ramp when it is the closer match", () => {
    expect(rgbToAnsi256(128, 128, 128)).toBe(244);
  });
});

describe("downsampleTruecolorCodes", () => {
  it("returns the input array untouched at truecolor level", () => {
    chalk.level = 3;
    const codes = [ansi("\x1b[38;2;215;119;87m", "\x1b[39m")];
    expect(downsampleTruecolorCodes(codes)).toBe(codes);
  });

  it("rewrites foreground truecolor to the xterm-256 nearest match", () => {
    chalk.level = 2;
    const out = downsampleTruecolorCodes([ansi("\x1b[38;2;215;119;87m", "\x1b[39m")]);
    expect(out).toEqual([ansi("\x1b[38;5;173m", "\x1b[39m")]);
  });

  it("rewrites background truecolor and keeps the end code", () => {
    chalk.level = 2;
    const out = downsampleTruecolorCodes([ansi("\x1b[48;2;128;128;128m", "\x1b[49m")]);
    expect(out).toEqual([ansi("\x1b[48;5;244m", "\x1b[49m")]);
  });

  it("keeps the array identity when no truecolor code is present", () => {
    chalk.level = 2;
    const codes = [ansi("\x1b[1m", "\x1b[22m"), ansi("\x1b[38;5;173m", "\x1b[39m")];
    expect(downsampleTruecolorCodes(codes)).toBe(codes);
  });

  it("preserves surrounding non-truecolor codes in order", () => {
    chalk.level = 2;
    const out = downsampleTruecolorCodes([
      ansi("\x1b[1m", "\x1b[22m"),
      ansi("\x1b[38;2;0;0;0m", "\x1b[39m"),
      ansi("\x1b[4m", "\x1b[24m"),
    ]);
    expect(out).toEqual([
      ansi("\x1b[1m", "\x1b[22m"),
      ansi("\x1b[38;5;16m", "\x1b[39m"),
      ansi("\x1b[4m", "\x1b[24m"),
    ]);
  });

  it("handles an empty style run", () => {
    chalk.level = 2;
    const codes: AnsiCode[] = [];
    expect(downsampleTruecolorCodes(codes)).toBe(codes);
  });
});
