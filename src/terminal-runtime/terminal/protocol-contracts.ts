export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type Color =
  | { type: "named"; name: NamedColor }
  | { type: "indexed"; index: number }
  | { type: "rgb"; r: number; g: number; b: number }
  | { type: "default" };

export type UnderlineStyle = "none" | "single" | "double" | "curly" | "dotted" | "dashed";

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

export function stylesMatch(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg) &&
    colorsEqual(a.underlineColor, b.underlineColor)
  );
}

export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "named":
      return a.name === (b as typeof a).name;
    case "indexed":
      return a.index === (b as typeof a).index;
    case "rgb":
      return a.r === (b as typeof a).r && a.g === (b as typeof a).g && a.b === (b as typeof a).b;
    case "default":
      return true;
  }
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
