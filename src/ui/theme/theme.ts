import {
  type CustomThemeId,
  THEME_NAMES,
  THEME_SETTINGS,
  type ThemeName,
  type ThemeSetting,
} from "@/kernel/config/theme-names.ts";
import { getPlatform } from "@/kernel/std/proc/platform.ts";
import type { TerminalColor } from "@/terminal-runtime";

export type { CustomThemeId, ThemeName, ThemeSetting };
export { THEME_NAMES, THEME_SETTINGS };

export interface ThemeRecord {
  primary: TerminalColor;
  primaryGlow: TerminalColor;
  /** The one accent every overlay panel wears: titles, rules, selection, pills. */
  panelAccent: TerminalColor;
  /** The product's warm signature hue: long-running product work in progress. */
  brand: TerminalColor;
  accentWarm: TerminalColor;
  text: TerminalColor;
  textStrong: TerminalColor;
  muted: TerminalColor;
  subtle: TerminalColor;
  success: TerminalColor;
  error: TerminalColor;
  warning: TerminalColor;
  highlight: TerminalColor;
  user: TerminalColor;
  inverseBg: TerminalColor;
  userText: TerminalColor;
  badgePrefix: TerminalColor;
  queueText: TerminalColor;
  queueBackground: TerminalColor;
  tabSelectedText: TerminalColor;
  assistant: TerminalColor;
  system: TerminalColor;
  modeYolo: TerminalColor;
  modeAccept: TerminalColor;
  modePlan: TerminalColor;
  designSession: TerminalColor;
  bashMode: TerminalColor;
  bashInputBg: TerminalColor;
  steel: TerminalColor;
  border: TerminalColor;
  chevron: TerminalColor;
  fastMode: TerminalColor;
  titleStrong: TerminalColor;
  toolBody: TerminalColor;
  diffAddBg: TerminalColor | undefined;
  diffAddHighlightBg: TerminalColor | undefined;
  diffAddDimBg: TerminalColor | undefined;
  diffRemBg: TerminalColor | undefined;
  diffRemHighlightBg: TerminalColor | undefined;
  diffRemDimBg: TerminalColor | undefined;
  diffAddFg: TerminalColor;
  diffRemFg: TerminalColor;
  diffContentFg: TerminalColor;
  syntaxKeyword: TerminalColor;
  syntaxString: TerminalColor;
  syntaxNumber: TerminalColor;
  syntaxTitle: TerminalColor;
  syntaxType: TerminalColor;
  syntaxSymbol: TerminalColor;
  inlineCode: TerminalColor;
}

const SHARED_TUI: Pick<
  ThemeRecord,
  | "primary"
  | "primaryGlow"
  | "panelAccent"
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
  panelAccent: "#00CCCC",
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
  brand: "#D77757",
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
  brand: "#FF9933",
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
  brand: "ansi:redBright",
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
  brand: "ansi:redBright",
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
let activeCustomThemeId: CustomThemeId | undefined;
let activeTheme: ThemeRecord = THEMES.dark;
const subscribers = new Set<() => void>();

/**
 * The shipped palette in force. A stored theme reports the palette it layers
 * onto, so callers that key off a light/dark distinction stay right without
 * knowing stored themes exist.
 */
export function getActiveThemeName(): ThemeName {
  return activeThemeName;
}

/** The stored theme in force, or undefined when a shipped palette is. */
export function getActiveCustomThemeId(): CustomThemeId | undefined {
  return activeCustomThemeId;
}

export function getThemeRecord(name: ThemeName): ThemeRecord {
  return THEMES[name];
}

function publish(): void {
  for (const sub of subscribers) sub();
}

export function setActiveTheme(name: ThemeName): void {
  if (name === activeThemeName && activeCustomThemeId === undefined) return;
  activeThemeName = name;
  activeCustomThemeId = undefined;
  activeTheme = THEMES[name];
  publish();
}

/**
 * Puts a stored theme in force. The palette it was built on is kept alongside,
 * since that is what `getActiveThemeName` owes its callers.
 */
export function setActiveCustomTheme(
  id: CustomThemeId,
  base: ThemeName,
  record: ThemeRecord,
): void {
  activeThemeName = base;
  activeCustomThemeId = id;
  activeTheme = record;
  publish();
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
export type ColorValue = TerminalColor;
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
  // Windows Terminal falls back to the emoji font for U+23F8 even with VS15;
  // two heavy bars carry the pause meaning without an emoji mapping.
  pause: getPlatform() === "macos" ? "⏸\uFE0E" : "❚❚",
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
  cross: "✘",
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
  arrowLeft: "←",
  arrowRight: "→",
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
  /** Lighter rule than `boxHLine`, for a divider inside a panel rather than around it. */
  boxHLineDashed: "╌",
  boxTeeDown: "┬",
  boxTeeUp: "┴",
  bullseye: "◎",
} as const;

export const GUTTER_HEAD = `  ${Glyph.boxSharpBottomLeft} `;
export const GUTTER_CONT = " ".repeat(GUTTER_HEAD.length);

export const TAGLINE = "a shell for the reversed world";
