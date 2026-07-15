import { csi } from "@/terminal-runtime/terminal/control-sequences.js";

export const DEC = {
  CURSOR_VISIBLE: 25,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  FOCUS_EVENTS: 1004,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_UPDATE: 2026,

  THEME_NOTIFY: 2031,
} as const;

export function decset(mode: number): string {
  return csi(`?${mode}h`);
}

export function decreset(mode: number): string {
  return csi(`?${mode}l`);
}

export const BSU = decset(DEC.SYNCHRONIZED_UPDATE);
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE);
export const EBP = decset(DEC.BRACKETED_PASTE);
export const DBP = decreset(DEC.BRACKETED_PASTE);
export const EFE = decset(DEC.FOCUS_EVENTS);
export const DFE = decreset(DEC.FOCUS_EVENTS);
export const CURSOR_DISPLAY_ON = decset(DEC.CURSOR_VISIBLE);
export const CURSOR_DISPLAY_OFF = decreset(DEC.CURSOR_VISIBLE);

export const MOUSE_CAPTURE_OFF =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL);

export const ENABLE_THEME_NOTIFY = decset(DEC.THEME_NOTIFY);
export const DISABLE_THEME_NOTIFY = decreset(DEC.THEME_NOTIFY);
