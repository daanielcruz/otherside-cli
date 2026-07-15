import { ESC, ESC_TYPE, SEP } from "@/terminal-runtime/terminal/ansi-control.js";

export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI);

export const CSI_RANGE = {
  PARAM_START: 0x30,
  PARAM_END: 0x3f,
  INTERMEDIATE_START: 0x20,
  INTERMEDIATE_END: 0x2f,
  FINAL_START: 0x40,
  FINAL_END: 0x7e,
} as const;

export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END;
}

export function isCSIIntermediate(byte: number): boolean {
  return byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END;
}

export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END;
}

export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX;
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`;
  const params = args.slice(0, -1);
  const final = args[args.length - 1];
  return `${CSI_PREFIX}${params.join(SEP)}${final}`;
}

export const CSI = {
  CUU: 0x41,
  CUD: 0x42,
  CUF: 0x43,
  CUB: 0x44,
  CNL: 0x45,
  CPL: 0x46,
  CHA: 0x47,
  CUP: 0x48,
  CHT: 0x49,
  VPA: 0x64,
  HVP: 0x66,

  ED: 0x4a,
  EL: 0x4b,
  ECH: 0x58,

  IL: 0x4c,
  DL: 0x4d,
  ICH: 0x40,
  DCH: 0x50,

  SM: 0x68,
  RM: 0x6c,

  SGR: 0x6d,

  DSR: 0x6e,
  DECSCUSR: 0x71,
  SCOSC: 0x73,
  SCORC: 0x75,
  CBT: 0x5a,
} as const;

export const ERASE_DISPLAY = ["toEnd", "toStart", "all", "scrollback"] as const;

export const ERASE_LINE_REGION = ["toEnd", "toStart", "all"] as const;

export type CursorStyle = "block" | "underline" | "bar";

export const CURSOR_STYLES: Array<{ style: CursorStyle; blinking: boolean }> = [
  { style: "block", blinking: true },
  { style: "block", blinking: true },
  { style: "block", blinking: false },
  { style: "underline", blinking: true },
  { style: "underline", blinking: false },
  { style: "bar", blinking: true },
  { style: "bar", blinking: false },
];

export function cursorUp(n = 1): string {
  return n === 0 ? "" : csi(n, "A");
}

export function cursorDown(n = 1): string {
  return n === 0 ? "" : csi(n, "B");
}

export function cursorForward(n = 1): string {
  return n === 0 ? "" : csi(n, "C");
}

export function cursorBack(n = 1): string {
  return n === 0 ? "" : csi(n, "D");
}

export function cursorTo(col: number): string {
  return csi(col, "G");
}

export const CURSOR_LEFT = csi("G");

export function cursorPosition(row: number, col: number): string {
  return csi(row, col, "H");
}

export const CURSOR_HOME = csi("H");

export function cursorMove(x: number, y: number): string {
  let result = "";

  if (x < 0) {
    result += cursorBack(-x);
  } else if (x > 0) {
    result += cursorForward(x);
  }

  if (y < 0) {
    result += cursorUp(-y);
  } else if (y > 0) {
    result += cursorDown(y);
  }
  return result;
}

export const CURSOR_SAVE = csi("s");

export const CURSOR_RESTORE = csi("u");

export function eraseToEndOfLine(): string {
  return csi("K");
}

export function eraseToStartOfLine(): string {
  return csi(1, "K");
}

export function eraseLine(): string {
  return csi(2, "K");
}

export const ERASE_LINE = csi(2, "K");

export function eraseToEndOfScreen(): string {
  return csi("J");
}

export function eraseToStartOfScreen(): string {
  return csi(1, "J");
}

export function eraseScreen(): string {
  return csi(2, "J");
}

export const ERASE_SCREEN = csi(2, "J");

export const ERASE_SCROLLBACK = csi(3, "J");

export function eraseLines(n: number): string {
  if (n <= 0) return "";
  let result = "";
  for (let i = 0; i < n; i++) {
    result += ERASE_LINE;
    if (i < n - 1) {
      result += cursorUp(1);
    }
  }
  result += CURSOR_LEFT;
  return result;
}

export const PASTE_START = csi("200~");

export const PASTE_END = csi("201~");

export const FOCUS_IN = csi("I");

export const FOCUS_OUT = csi("O");

export const ENABLE_KITTY_KEYBOARD = csi(">1u");

export const DISABLE_KITTY_KEYBOARD = csi("<u");

export const ENABLE_MODIFY_OTHER_KEYS = csi(">4;2m");

export const DISABLE_MODIFY_OTHER_KEYS = csi(">4m");
