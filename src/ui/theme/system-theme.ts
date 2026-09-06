import type { BuiltinThemeSetting, ThemeName } from "@/kernel/config/theme-names.ts";

export type SystemTheme = "dark" | "light";

let cached: SystemTheme | undefined;

export function getSystemTheme(): SystemTheme {
  if (cached === undefined) cached = readColorFgBg() ?? "dark";
  return cached;
}

export function cacheSystemTheme(value: SystemTheme): void {
  cached = value;
}

/**
 * Narrows a shipped setting to the palette it names. A stored theme is not one
 * of these — it resolves through its own record, which carries the base.
 */
export function resolveThemeSetting(setting: BuiltinThemeSetting): ThemeName {
  return setting === "auto" ? getSystemTheme() : setting;
}

export function classifyByLuminance(r: number, g: number, b: number): SystemTheme {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.5 ? "light" : "dark";
}

const OSC_RGB = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i;
const OSC_HASH = /^#([0-9a-f]+)$/i;

export function parseOscColor(payload: string): SystemTheme | undefined {
  const rgb = parseRgb(payload);
  if (!rgb) return undefined;
  return classifyByLuminance(rgb.r, rgb.g, rgb.b);
}

interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

function parseRgb(data: string): Rgb01 | undefined {
  const m = OSC_RGB.exec(data);
  if (m) {
    return {
      r: hexFraction(m[1] ?? ""),
      g: hexFraction(m[2] ?? ""),
      b: hexFraction(m[3] ?? ""),
    };
  }
  const h = OSC_HASH.exec(data);
  if (h) {
    const hex = h[1] ?? "";
    if (hex.length % 3 !== 0) return undefined;
    const n = hex.length / 3;
    return {
      r: hexFraction(hex.slice(0, n)),
      g: hexFraction(hex.slice(n, 2 * n)),
      b: hexFraction(hex.slice(2 * n)),
    };
  }
  return undefined;
}

function hexFraction(hex: string): number {
  if (hex.length === 0) return 0;
  return Number.parseInt(hex, 16) / (16 ** hex.length - 1);
}

function readColorFgBg(): SystemTheme | undefined {
  const raw = process.env.COLORFGBG;
  if (!raw) return undefined;
  const parts = raw.split(";");
  const tail = parts[parts.length - 1];
  if (!tail) return undefined;
  const n = Number(tail);
  if (!Number.isInteger(n) || n < 0 || n > 15) return undefined;
  return n <= 6 || n === 8 ? "dark" : "light";
}
