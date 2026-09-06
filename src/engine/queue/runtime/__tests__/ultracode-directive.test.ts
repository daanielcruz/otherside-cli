import { describe, expect, it } from "bun:test";
import { hasUltracodeKeyword } from "@/engine/queue/runtime/ultracode-directive.ts";

describe("hasUltracodeKeyword", () => {
  it.each([
    "ultracode",
    "please ULTRACODE this",
    "ultracode.",
    "ultracode!",
    "ultracode, please",
    "let's ultracode this",
    "n < 5 ultracode n > 10",
    '"ultracode" then ultracode',
    " /rename ultracode",
  ])("recognizes a launch directive in %j", (text) => {
    expect(hasUltracodeKeyword(text)).toBe(true);
  });

  it.each([
    "",
    "myultracode",
    "ultracode2",
    "ultracode_name",
    "/rename ultracode",
    "src/ultracode/file.ts",
    "src\\ultracode\\file.ts",
    "--ultracode-mode",
    "ultracode.tsx",
    "ultracode?",
    "`ultracode`",
    '"ultracode"',
    "'ultracode'",
    "(ultracode)",
    "{ultracode}",
    "[ultracode]",
    "[prefix [ultracode] suffix]",
    "<tag ultracode>",
  ])("ignores non-directive use in %j", (text) => {
    expect(hasUltracodeKeyword(text)).toBe(false);
  });
});
