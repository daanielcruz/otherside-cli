// Keyboard rules for entering and leaving `!` bash input mode.
//
// Entering: typing `!` at offset 0 of an EMPTY prompt. Anywhere else the
// character inserts normally.
// Leaving: Backspace or Esc pressed at offset 0 while the mode is active
// (the buffer, edited or not, stays put — only the mode flips).

import { BASH_MODE_PREFIX } from "@/engine/queue/turn/bash-input.ts";

export function entersBashMode(input: {
  key: string;
  buffer: string;
  cursor: number;
  bashMode: boolean;
}): boolean {
  const { key, buffer, cursor, bashMode } = input;
  return !bashMode && key === BASH_MODE_PREFIX && buffer.length === 0 && cursor === 0;
}

export function exitsBashMode(input: { cursor: number; bashMode: boolean }): boolean {
  return input.bashMode && input.cursor === 0;
}
