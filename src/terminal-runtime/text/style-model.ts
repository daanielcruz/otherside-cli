import type { Boxes, BoxStyle } from "cli-boxes";

const PRODUCT_BORDER_GLYPHS = {
  dashed: {
    top: "╌",
    left: "╎",
    right: "╎",
    bottom: "╌",
    topLeft: " ",
    topRight: " ",
    bottomLeft: " ",
    bottomRight: " ",
  },
} as const;

export type BorderStyle = keyof Boxes | keyof typeof PRODUCT_BORDER_GLYPHS | BoxStyle;

export type RGBColor = `rgb(${number},${number},${number})`;
export type HexColor = `#${string}`;
export type Ansi256Color = `ansi256(${number})`;
export type AnsiColor =
  | "ansi:black"
  | "ansi:red"
  | "ansi:green"
  | "ansi:yellow"
  | "ansi:blue"
  | "ansi:magenta"
  | "ansi:cyan"
  | "ansi:white"
  | "ansi:blackBright"
  | "ansi:redBright"
  | "ansi:greenBright"
  | "ansi:yellowBright"
  | "ansi:blueBright"
  | "ansi:magentaBright"
  | "ansi:cyanBright"
  | "ansi:whiteBright";

export type TerminalColor = RGBColor | HexColor | Ansi256Color | AnsiColor;

export type TerminalTextStyle = {
  readonly color?: TerminalColor;
  readonly backgroundColor?: TerminalColor;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly inverse?: boolean;
};
