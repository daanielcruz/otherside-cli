import { writeSync } from "node:fs";
import { emitTerminalProgress } from "@/kernel/std/terminal-progress.ts";

const RESTORE_ASCII_CHARSET = "\x1B(B\x0F";
const DISABLE_MODIFY_OTHER_KEYS = "\x1B[>4m";
const DISABLE_KITTY_KEYBOARD = "\x1B[<u";
const DISABLE_FOCUS_EVENTS = "\x1B[?1004l";
const DISABLE_THEME_NOTIFY = "\x1B[?2031l";
const DISABLE_BRACKETED_PASTE = "\x1B[?2004l";
const SHOW_CURSOR = "\x1B[?25h";
const RESET_SCROLL_REGION = "\x1B[r";

export function restoreTerminalModes(): void {
  try {
    writeSync(1, RESTORE_ASCII_CHARSET);
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS);
    writeSync(1, DISABLE_KITTY_KEYBOARD);
    writeSync(1, DISABLE_FOCUS_EVENTS);
    writeSync(1, DISABLE_THEME_NOTIFY);
    writeSync(1, DISABLE_BRACKETED_PASTE);
    writeSync(1, SHOW_CURSOR);
    writeSync(1, `\x1B7${RESET_SCROLL_REGION}\x1B8`);
    emitTerminalProgress("completed");
  } catch {}
}

let restoreOnExitInstalled = false;

const SIGNAL_EXIT_CODES: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

export function installTerminalRestoreOnExit(): void {
  if (restoreOnExitInstalled) return;
  restoreOnExitInstalled = true;
  process.on("exit", restoreTerminalModes);
  for (const [signal, code] of SIGNAL_EXIT_CODES) {
    process.on(signal, () => {
      restoreTerminalModes();
      process.exit(code);
    });
  }
}
