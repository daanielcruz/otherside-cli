import {
  CURSOR_HOME,
  cursorDown,
  ERASE_LINE,
} from "@/terminal-runtime/terminal/control-sequences.js";

export function eraseViewportInPlace(height: number): string {
  return CURSOR_HOME + (ERASE_LINE + cursorDown(1)).repeat(height) + CURSOR_HOME;
}
