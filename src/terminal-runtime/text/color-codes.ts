import type { AnsiCode } from "@alcalzone/ansi-tokenize";
import chalk from "chalk";
import type { TerminalColor, TerminalTextStyle } from "@/terminal-runtime/text/style-model.js";

const NO_COLOR_FLAGS = new Set(["--no-color", "--no-colors", "--color=false", "--color=never"]);
const FORCE_COLOR_FLAGS = new Set([
  "--color",
  "--colors",
  "--color=true",
  "--color=always",
  "--color=256",
  "--color=16m",
  "--color=full",
  "--color=truecolor",
]);
const MODERN_TERMINALS = new Set([
  "alacritty",
  "contour",
  "foot",
  "ghostty",
  "rio",
  "wezterm",
  "xterm-ghostty",
  "xterm-kitty",
]);

function hasArgFlag(flags: Set<string>): boolean {
  const doubleDashIdx = process.argv.indexOf("--");
  const args = doubleDashIdx === -1 ? process.argv : process.argv.slice(0, doubleDashIdx);
  return args.some((arg) => flags.has(arg));
}

function muteColorForNoColorEnv(): boolean {
  if (
    process.env.NO_COLOR &&
    process.env.FORCE_COLOR === undefined &&
    !hasArgFlag(FORCE_COLOR_FLAGS) &&
    chalk.level > 0
  ) {
    chalk.level = 0;
    return true;
  }
  return false;
}

function elevateColorDepthForXterm(): boolean {
  if (process.env.TERM_PROGRAM === "vscode" && chalk.level === 2) {
    chalk.level = 3;
    return true;
  }
  return false;
}

export function terminalAdvertisesTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return true;
  const term = env.TERM?.toLowerCase();
  return term?.includes("truecolor") === true || term?.includes("direct") === true;
}

function elevateColorDepthForModernTerminals(): boolean {
  if (
    !process.stdout.isTTY ||
    process.env.NO_COLOR ||
    process.env.FORCE_COLOR !== undefined ||
    hasArgFlag(NO_COLOR_FLAGS)
  ) {
    return false;
  }
  const term = process.env.TERM;
  if (
    (terminalAdvertisesTruecolor() || (term !== undefined && MODERN_TERMINALS.has(term))) &&
    chalk.level < 3
  ) {
    chalk.level = 3;
    return true;
  }
  return false;
}

function limitColorDepthForTmuxTerminal(): boolean {
  if (process.env.OTHERSIDE_TMUX_TRUECOLOR || terminalAdvertisesTruecolor()) return false;
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2;
    return true;
  }
  return false;
}

export const COLOR_DEPTH_MUTED_FOR_NO_COLOR = muteColorForNoColorEnv();
export const COLOR_DEPTH_ELEVATED_FOR_XTERM = elevateColorDepthForXterm();
export const COLOR_DEPTH_ELEVATED_FOR_MODERN_TERMINALS = elevateColorDepthForModernTerminals();
export const COLOR_DEPTH_LIMITED_FOR_TMUX = limitColorDepthForTmuxTerminal();

const TRUECOLOR_SGR = /^\x1b\[([34]8);2;(\d+);(\d+);(\d+)m$/;
const TRUECOLOR_DEPTH = 3;

const ANSI_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/**
 * Whether the resolved colour depth carries 24-bit values through untouched. Below it
 * every truecolor run is downsampled, so near-identical shades land on the same cell.
 */
export function rendersTruecolor(): boolean {
  return chalk.level >= TRUECOLOR_DEPTH;
}

export function rgbToAnsi256(r: number, g: number, b: number): number {
  const level = (v: number): number =>
    v < 48 ? 0 : v < 115 ? 1 : v < 155 ? 2 : v < 195 ? 3 : v < 235 ? 4 : 5;
  const ri = level(r);
  const gi = level(g);
  const bi = level(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const avg = Math.round((r + g + b) / 3);
  if (avg < 5) return 16;
  if (avg > 244 && ri === gi && gi === bi) return cube;
  const grayIdx = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const grayCode = 232 + grayIdx;
  const grayValue = 8 + grayIdx * 10;
  const cr = ANSI_CUBE_LEVELS[ri] ?? 0;
  const cg = ANSI_CUBE_LEVELS[gi] ?? 0;
  const cb = ANSI_CUBE_LEVELS[bi] ?? 0;
  const cubeDist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  return (r - grayValue) ** 2 + (g - grayValue) ** 2 + (b - grayValue) ** 2 < cubeDist
    ? grayCode
    : cube;
}

export function downsampleTruecolorCodes(codes: AnsiCode[]): AnsiCode[] {
  if (rendersTruecolor() || codes.length === 0) return codes;
  let out: AnsiCode[] | undefined;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === undefined) continue;
    const match = TRUECOLOR_SGR.exec(code.code);
    if (match) {
      out ??= codes.slice(0, i);
      out.push({
        type: "ansi",
        code: `\x1b[${match[1]};5;${rgbToAnsi256(Number(match[2]), Number(match[3]), Number(match[4]))}m`,
        endCode: code.endCode,
      });
    } else if (out) {
      out.push(code);
    }
  }
  return out ?? codes;
}

export type ColorChannel = "foreground" | "background";

const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/;
const ANSI_REGEX = /^ansi256\(\s?(\d+)\s?\)$/;

export const colorize = (str: string, color: string | undefined, type: ColorChannel): string => {
  if (!color) {
    return str;
  }

  if (color.startsWith("ansi:")) {
    const value = color.substring("ansi:".length);
    switch (value) {
      case "black":
        return type === "foreground" ? chalk.black(str) : chalk.bgBlack(str);
      case "red":
        return type === "foreground" ? chalk.red(str) : chalk.bgRed(str);
      case "green":
        return type === "foreground" ? chalk.green(str) : chalk.bgGreen(str);
      case "yellow":
        return type === "foreground" ? chalk.yellow(str) : chalk.bgYellow(str);
      case "blue":
        return type === "foreground" ? chalk.blue(str) : chalk.bgBlue(str);
      case "magenta":
        return type === "foreground" ? chalk.magenta(str) : chalk.bgMagenta(str);
      case "cyan":
        return type === "foreground" ? chalk.cyan(str) : chalk.bgCyan(str);
      case "white":
        return type === "foreground" ? chalk.white(str) : chalk.bgWhite(str);
      case "blackBright":
        return type === "foreground" ? chalk.blackBright(str) : chalk.bgBlackBright(str);
      case "redBright":
        return type === "foreground" ? chalk.redBright(str) : chalk.bgRedBright(str);
      case "greenBright":
        return type === "foreground" ? chalk.greenBright(str) : chalk.bgGreenBright(str);
      case "yellowBright":
        return type === "foreground" ? chalk.yellowBright(str) : chalk.bgYellowBright(str);
      case "blueBright":
        return type === "foreground" ? chalk.blueBright(str) : chalk.bgBlueBright(str);
      case "magentaBright":
        return type === "foreground" ? chalk.magentaBright(str) : chalk.bgMagentaBright(str);
      case "cyanBright":
        return type === "foreground" ? chalk.cyanBright(str) : chalk.bgCyanBright(str);
      case "whiteBright":
        return type === "foreground" ? chalk.whiteBright(str) : chalk.bgWhiteBright(str);
    }
  }

  if (color.startsWith("#")) {
    return type === "foreground" ? chalk.hex(color)(str) : chalk.bgHex(color)(str);
  }

  if (color.startsWith("ansi256")) {
    const matches = ANSI_REGEX.exec(color);

    if (!matches) {
      return str;
    }

    const value = Number(matches[1]);

    return type === "foreground" ? chalk.ansi256(value)(str) : chalk.bgAnsi256(value)(str);
  }

  if (color.startsWith("rgb")) {
    const matches = RGB_REGEX.exec(color);

    if (!matches) {
      return str;
    }

    const firstValue = Number(matches[1]);
    const secondValue = Number(matches[2]);
    const thirdValue = Number(matches[3]);

    return type === "foreground"
      ? chalk.rgb(firstValue, secondValue, thirdValue)(str)
      : chalk.bgRgb(firstValue, secondValue, thirdValue)(str);
  }

  return str;
};

export function renderTextWithStyles(text: string, styles: TerminalTextStyle): string {
  let result = text;

  if (styles.inverse) {
    result = chalk.inverse(result);
  }

  if (styles.strikethrough) {
    result = chalk.strikethrough(result);
  }

  if (styles.underline) {
    result = chalk.underline(result);
  }

  if (styles.italic) {
    result = chalk.italic(result);
  }

  if (styles.bold) {
    result = chalk.bold(result);
  }

  if (styles.dim) {
    result = chalk.dim(result);
  }

  if (styles.color) {
    result = colorize(result, styles.color, "foreground");
  }

  if (styles.backgroundColor) {
    result = colorize(result, styles.backgroundColor, "background");
  }

  return result;
}

export function renderColoredText(text: string, color: TerminalColor | undefined): string {
  if (!color) {
    return text;
  }
  return colorize(text, color, "foreground");
}
