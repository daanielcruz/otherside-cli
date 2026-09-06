import chalk from "chalk";
import { type ColorChannel, colorize } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";

export const dim = (str: string): string => chalk.dim(str);

export function resolveColorSequence(
  color: TerminalColor | undefined,
  target: ColorChannel,
): { open: string; close: string } {
  const marker = "\u0001";
  const wrapped = colorize(marker, color, target);
  const idx = wrapped.indexOf(marker);
  if (idx < 0) return { open: "", close: "" };
  return { open: wrapped.slice(0, idx), close: wrapped.slice(idx + marker.length) };
}
