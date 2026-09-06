import { writeSync } from "node:fs";
import { C0, ESC } from "@/terminal-runtime/terminal/ansi-control.js";
import {
  csi,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
} from "@/terminal-runtime/terminal/control-sequences.js";
import {
  CURSOR_DISPLAY_ON,
  DBP,
  DFE,
  DISABLE_THEME_NOTIFY,
} from "@/terminal-runtime/terminal/private-modes.js";
import { emitTerminalProgress } from "@/terminal-runtime/terminal/progress-report.js";

const BASE_CHARACTER_SET = `${ESC}(B${String.fromCharCode(C0.SI)}`;
const UNBOUNDED_SCROLL_REGION = `${ESC}7${csi("r")}${ESC}8`;
const RECOVERY_BYTES = [
  BASE_CHARACTER_SET,
  DISABLE_MODIFY_OTHER_KEYS,
  DISABLE_KITTY_KEYBOARD,
  DFE,
  DISABLE_THEME_NOTIFY,
  DBP,
  CURSOR_DISPLAY_ON,
  UNBOUNDED_SCROLL_REGION,
] as const;

export function recoverTerminal(): void {
  try {
    for (const bytes of RECOVERY_BYTES) writeSync(1, bytes);
    emitTerminalProgress("completed");
  } catch {}
}

let recoveryHooksReady = false;

const SIGNAL_STATUS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

export function registerTerminalRecovery(): void {
  if (recoveryHooksReady) return;
  recoveryHooksReady = true;
  process.on("exit", recoverTerminal);
  for (const [signal, status] of SIGNAL_STATUS) {
    process.on(signal, () => {
      recoverTerminal();
      process.exit(status);
    });
  }
}
