import type { AnsiColor, TerminalColor } from "@/terminal-runtime/text/style-model.ts";

/**
 * The four notations a slot value may be written in, in the order the prompt
 * advertises them.
 */
export const COLOR_VALUE_FORMS = "rgb(r,g,b), #rrggbb, ansi256(n), or ansi:name";

/** Every `ansi:` name the style model renders. */
const ANSI_COLOR_NAMES = [
  "ansi:black",
  "ansi:red",
  "ansi:green",
  "ansi:yellow",
  "ansi:blue",
  "ansi:magenta",
  "ansi:cyan",
  "ansi:white",
  "ansi:blackBright",
  "ansi:redBright",
  "ansi:greenBright",
  "ansi:yellowBright",
  "ansi:blueBright",
  "ansi:magentaBright",
  "ansi:cyanBright",
  "ansi:whiteBright",
] as const satisfies readonly AnsiColor[];

type AssertNever<T extends never> = T;
/** Fails to compile when the style model gains a name this set does not carry. */
type _AnsiNamesAreExhaustive = AssertNever<Exclude<AnsiColor, (typeof ANSI_COLOR_NAMES)[number]>>;

const ANSI_NAME_SET: ReadonlySet<string> = new Set(ANSI_COLOR_NAMES);

const HEX = /^#[0-9a-f]{6}$/i;
const RGB = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/;
const ANSI256 = /^ansi256\(\s*(\d+)\s*\)$/;

/**
 * Reads a slot value as written by hand. Returns undefined for anything the
 * style model cannot render, which is what the prompt reports as a refusal.
 *
 * Only the notation is checked, not the magnitude: a channel or palette index
 * past its usual ceiling parses and is handed to the terminal as written, which
 * clamps it. Refusing it here would reject a value that still paints.
 */
export function parseColorValue(input: string): TerminalColor | undefined {
  const text = input.trim();
  if (text.length === 0) return undefined;

  if (HEX.test(text)) return text as TerminalColor;

  const rgb = RGB.exec(text);
  if (rgb) return `rgb(${Number(rgb[1])},${Number(rgb[2])},${Number(rgb[3])})`;

  const ansi256 = ANSI256.exec(text);
  if (ansi256) return `ansi256(${Number(ansi256[1])})`;

  if (ANSI_NAME_SET.has(text)) return text as AnsiColor;

  return undefined;
}

export function isColorValue(input: string): boolean {
  return parseColorValue(input) !== undefined;
}
