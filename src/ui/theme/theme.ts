import type { Color as InkColor } from "@/ink";
import {
  THEME_NAMES,
  THEME_SETTINGS,
  type ThemeName,
  type ThemeSetting,
} from "@/kernel/config/theme-names.ts";
import { getPlatform } from "@/kernel/std/proc/platform.ts";

export type { ThemeName, ThemeSetting };
export { THEME_NAMES, THEME_SETTINGS };

export interface ThemeRecord {
  primary: InkColor;
  primaryGlow: InkColor;
  accentWarm: InkColor;
  text: InkColor;
  textStrong: InkColor;
  muted: InkColor;
  subtle: InkColor;
  success: InkColor;
  error: InkColor;
  warning: InkColor;
  highlight: InkColor;
  user: InkColor;
  inverseBg: InkColor;
  userText: InkColor;
  badgePrefix: InkColor;
  queueText: InkColor;
  queueBackground: InkColor;
  tabSelectedText: InkColor;
  assistant: InkColor;
  system: InkColor;
  modeYolo: InkColor;
  modeAccept: InkColor;
  modePlan: InkColor;
  designSession: InkColor;
  bashMode: InkColor;
  bashInputBg: InkColor;
  steel: InkColor;
  border: InkColor;
  chevron: InkColor;
  fastMode: InkColor;
  titleStrong: InkColor;
  toolBody: InkColor;
  diffAddBg: InkColor | undefined;
  diffAddHighlightBg: InkColor | undefined;
  diffAddDimBg: InkColor | undefined;
  diffRemBg: InkColor | undefined;
  diffRemHighlightBg: InkColor | undefined;
  diffRemDimBg: InkColor | undefined;
  diffAddFg: InkColor;
  diffRemFg: InkColor;
  diffContentFg: InkColor;
  syntaxKeyword: InkColor;
  syntaxString: InkColor;
  syntaxNumber: InkColor;
  syntaxTitle: InkColor;
  syntaxType: InkColor;
  syntaxSymbol: InkColor;
  inlineCode: InkColor;
}

const SHARED_TUI: Pick<
  ThemeRecord,
  | "primary"
  | "primaryGlow"
  | "highlight"
  | "modeYolo"
  | "modeAccept"
  | "modePlan"
  | "designSession"
  | "bashMode"
  | "bashInputBg"
  | "fastMode"
  | "titleStrong"
  | "chevron"
  | "border"
  | "badgePrefix"
  | "queueText"
  | "queueBackground"
  | "tabSelectedText"
  | "syntaxKeyword"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxTitle"
  | "syntaxType"
  | "syntaxSymbol"
> = {
  primary: "#3EA0C3",
  primaryGlow: "#B1B9F9",
  highlight: "#B1B9F9",
  modeYolo: "#FF6B80",
  modeAccept: "#48AAAA",
  modePlan: "#48968C",
  designSession: "#4EBA65",
  bashMode: "#FD5DB1",
  bashInputBg: "#413C41",
  fastMode: "#D96F7D",
  titleStrong: "#FFFFFF",
  chevron: "#888888",
  border: "#888888",
  badgePrefix: "#4E4E4E",
  queueText: "#FFFFFF",
  queueBackground: "#3A3A3A",
  tabSelectedText: "#000000",
  syntaxKeyword: "ansi:blue",
  syntaxString: "ansi:red",
  syntaxNumber: "ansi:green",
  syntaxTitle: "ansi:yellow",
  syntaxType: "ansi:cyan",
  syntaxSymbol: "ansi:magenta",
};

const DARK: ThemeRecord = {
  ...SHARED_TUI,
  accentWarm: "#af87ff",
  text: "#D4D4D4",
  textStrong: "#FFFFFF",
  muted: "#999999",
  subtle: "#505050",
  success: "#4EBA65",
  error: "#FF6B80",
  warning: "#FFC107",
  steel: "#6A9BCC",
  user: "#FFFFFF",
  inverseBg: "#373737",
  userText: "#FFFFFF",
  assistant: "#D4D4D4",
  system: "#999999",
  toolBody: "#D4D4D4",
  diffAddBg: "#022800",
  diffAddHighlightBg: "#044700",
  diffAddDimBg: "#011600",
  diffRemBg: "#3D0100",
  diffRemHighlightBg: "#5C0200",
  diffRemDimBg: "#220000",
  diffAddFg: "#50C850",
  diffRemFg: "#DC5A5A",
  diffContentFg: "#F8F8F2",
  inlineCode: "#B1B9F9",
};

const LIGHT: ThemeRecord = {
  ...SHARED_TUI,
  accentWarm: "#8700ff",
  text: "#000000",
  textStrong: "#000000",
  muted: "#666666",
  subtle: "#AFAFAF",
  success: "#2C7A39",
  designSession: "#2C7A39",
  error: "#AB2B3F",
  warning: "#966C1E",
  steel: "#6A9BCC",
  user: "#000000",
  inverseBg: "#F0F0F0",
  userText: "#000000",
  assistant: "#000000",
  system: "#666666",
  toolBody: "#000000",
  diffAddBg: "#DCFFDC",
  diffAddHighlightBg: "#B2FFB2",
  diffAddDimBg: "#EEFFEE",
  diffRemBg: "#FFDCDC",
  diffRemHighlightBg: "#FFC7C7",
  diffRemDimBg: "#FFEEEE",
  diffAddFg: "#248A3D",
  diffRemFg: "#CF222E",
  diffContentFg: "#333333",
  inlineCode: "#5769F7",
};

const DARK_DALTONIZED: ThemeRecord = {
  ...DARK,
  accentWarm: "#af87ff",
  diffAddBg: "#001B29",
  diffAddHighlightBg: "#003047",
  diffAddDimBg: "#000E15",
  diffAddFg: "#51A0C8",
  inlineCode: "#99CCFF",
};

const LIGHT_DALTONIZED: ThemeRecord = {
  ...LIGHT,
  accentWarm: "#8700ff",
  diffAddBg: "#DBEDFF",
  diffAddHighlightBg: "#B3D9FF",
  diffAddDimBg: "#EEF6FF",
  diffAddFg: "#24578A",
  inlineCode: "#3366FF",
};

const DARK_ANSI: ThemeRecord = {
  ...DARK,
  accentWarm: "ansi:magentaBright",
  diffAddBg: undefined,
  diffAddHighlightBg: undefined,
  diffAddDimBg: undefined,
  diffRemBg: undefined,
  diffRemHighlightBg: undefined,
  diffRemDimBg: undefined,
  diffAddFg: "ansi:greenBright",
  diffRemFg: "ansi:redBright",
  diffContentFg: "ansi:white",
  inlineCode: "ansi:blueBright",
};

const LIGHT_ANSI: ThemeRecord = {
  ...LIGHT,
  accentWarm: "ansi:magenta",
  diffAddBg: undefined,
  diffAddHighlightBg: undefined,
  diffAddDimBg: undefined,
  diffRemBg: undefined,
  diffRemHighlightBg: undefined,
  diffRemDimBg: undefined,
  diffAddFg: "ansi:greenBright",
  diffRemFg: "ansi:redBright",
  diffContentFg: "ansi:white",
  inlineCode: "ansi:blue",
};

const THEMES: Record<ThemeName, ThemeRecord> = {
  dark: DARK,
  light: LIGHT,
  "dark-daltonized": DARK_DALTONIZED,
  "light-daltonized": LIGHT_DALTONIZED,
  "dark-ansi": DARK_ANSI,
  "light-ansi": LIGHT_ANSI,
};

let activeThemeName: ThemeName = "dark";
let activeTheme: ThemeRecord = THEMES.dark;
const subscribers = new Set<() => void>();

export function getActiveThemeName(): ThemeName {
  return activeThemeName;
}

export function getThemeRecord(name: ThemeName): ThemeRecord {
  return THEMES[name];
}

export function setActiveTheme(name: ThemeName): void {
  if (name === activeThemeName) return;
  activeThemeName = name;
  activeTheme = THEMES[name];
  for (const sub of subscribers) sub();
}

export function subscribeTheme(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const Color = new Proxy({} as ThemeRecord, {
  get(_target, prop: string) {
    return activeTheme[prop as keyof ThemeRecord];
  },
  ownKeys() {
    return Object.keys(activeTheme);
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    return {
      enumerable: true,
      configurable: true,
      value: activeTheme[prop as keyof ThemeRecord],
    };
  },
}) as ThemeRecord;

export type ColorKey = keyof ThemeRecord;
export type ColorValue = InkColor;
export type SolidColorKey = {
  [K in ColorKey]: undefined extends ThemeRecord[K] ? never : K;
}[ColorKey];

export const Border = {
  default: "single",
  bold: "bold",
  round: "round",
} as const;

export const Glyph = {
  chevron: "❯ ",
  // Prompt-bar chevron pads with NBSP; list rows keep the plain-space variant.
  promptChevron: "❯\u00A0",
  chevronThin: "› ",
  promptBusy: "… ",
  bolt: "↯",
  fastForward: "⏵",
  // U+FE0E forces text presentation: bare U+23F8 falls back to the emoji font
  // on terminals whose mono font lacks the glyph.
  pause: "⏸\uFE0E",
  bullet: getPlatform() === "macos" ? "⏺" : "●",
  bulletFilled: "●",
  bulletHollow: "○",
  circleLarge: "◯",
  radioOn: "◉",
  lozenge: "¤",
  systemBullet: "  ",
  divider: " · ",
  triangle: "▸",
  triangleFilled: "▶",
  check: "✔",
  checkThin: "✓",
  squareFilled: "■",
  squareHollow: "□",
  squareSmallFilled: "◼",
  squareSmall: "◻",
  ballotBox: "☐",
  ballotBoxX: "☒",
  warning: "⚠",
  circledSlash: "⊘",
  search: "⌕",
  arrowUp: "↑",
  arrowDown: "↓",
  barFilled: "▰",
  barEmpty: "▱",
  block: "█",
  blockLight: "░",
  blockHalf: "▌",
  blockThreeEighths: "▍",
  blockQuarter: "▎",
  therefore: "∴",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  boxSharpTopLeft: "┌",
  boxSharpTopRight: "┐",
  boxSharpBottomLeft: "└",
  boxSharpBottomRight: "┘",
  boxLeftTee: "├",
  boxRightTee: "┤",
  boxCross: "┼",
  boxPipe: "│",
  boxHLine: "─",
  boxTeeDown: "┬",
  boxTeeUp: "┴",
  bullseye: "◎",
} as const;

export const GUTTER_HEAD = `  ${Glyph.boxSharpBottomLeft} `;
export const GUTTER_CONT = " ".repeat(GUTTER_HEAD.length);

export const TAGLINE = "a shell for the reversed world";
