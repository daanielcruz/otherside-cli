export const NAMED_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type NamedColor = (typeof NAMED_COLORS)[number];

export type Color =
  | { type: "named"; name: NamedColor }
  | { type: "indexed"; index: number }
  | { type: "rgb"; r: number; g: number; b: number }
  | { type: "default" };

export const UNDERLINE_STYLES = ["none", "single", "double", "curly", "dotted", "dashed"] as const;
export type UnderlineStyle = (typeof UNDERLINE_STYLES)[number];

export type TextStyle = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  blink: boolean;
  inverse: boolean;
  hidden: boolean;
  strikethrough: boolean;
  overline: boolean;
  fg: Color;
  bg: Color;
  underlineColor: Color;
};

export function createDefaultStyle(): TextStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: "none",
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    fg: { type: "default" },
    bg: { type: "default" },
    underlineColor: { type: "default" },
  };
}

export type CursorDirection = "up" | "down" | "forward" | "back";

export type CursorAction =
  | { type: "move"; direction: CursorDirection; count: number }
  | { type: "position"; row: number; col: number }
  | { type: "column"; col: number }
  | { type: "row"; row: number }
  | { type: "save" }
  | { type: "restore" }
  | { type: "show" }
  | { type: "hide" }
  | {
      type: "style";
      style: "block" | "underline" | "bar";
      blinking: boolean;
    }
  | { type: "nextLine"; count: number }
  | { type: "prevLine"; count: number };

export type EraseAction =
  | { type: "display"; region: "toEnd" | "toStart" | "all" | "scrollback" }
  | { type: "line"; region: "toEnd" | "toStart" | "all" }
  | { type: "chars"; count: number };

export type ModeAction =
  | { type: "bracketedPaste"; enabled: boolean }
  | { type: "focusEvents"; enabled: boolean };

export type LinkAction =
  | { type: "start"; url: string; params?: Record<string, string> | undefined }
  | { type: "end" };

export type TitleAction =
  | { type: "windowTitle"; title: string }
  | { type: "iconName"; name: string }
  | { type: "both"; title: string };

export type TabStatusAction = {
  indicator?: Color | null;
  status?: string | null;
  statusColor?: Color | null;
};

export type TextSegment = {
  type: "text";
  text: string;
  style: TextStyle;
};

export type Grapheme = {
  value: string;
  width: 1 | 2;
};

export type Action =
  | { type: "text"; graphemes: Grapheme[]; style: TextStyle }
  | { type: "cursor"; action: CursorAction }
  | { type: "erase"; action: EraseAction }
  | { type: "mode"; action: ModeAction }
  | { type: "link"; action: LinkAction }
  | { type: "title"; action: TitleAction }
  | { type: "tabStatus"; action: TabStatusAction }
  | { type: "sgr"; params: string }
  | { type: "bell" }
  | { type: "reset" }
  | { type: "unknown"; sequence: string };
