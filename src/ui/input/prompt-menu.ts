import { setPromptMenuOpen } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";

export const PROMPT_MENU_ROWS = 6;

const menuOwners = new Set<object>();

export function claimPromptMenu(owner: object): void {
  if (menuOwners.has(owner)) return;
  menuOwners.add(owner);
  if (menuOwners.size === 1) setPromptMenuOpen(true);
}

export function releasePromptMenu(owner: object): void {
  if (!menuOwners.delete(owner)) return;
  if (menuOwners.size === 0) setPromptMenuOpen(false);
}

export interface PromptMenuWindow<T> {
  start: number;
  visible: readonly T[];
}

export function promptMenuWindow<T>(options: readonly T[], selected: number): PromptMenuWindow<T> {
  const start =
    selected < PROMPT_MENU_ROWS ? 0 : Math.min(selected - PROMPT_MENU_ROWS + 1, options.length - 1);
  return { start, visible: options.slice(start, start + PROMPT_MENU_ROWS) };
}

export function promptMenuSelection(
  key: KeyEventData,
  selected: number,
  count: number,
  wrap = false,
): number | undefined {
  const isNext = key.name === "down" || (key.ctrl && !key.meta && key.name === "n");
  const isPrevious = key.name === "up" || (key.ctrl && !key.meta && key.name === "p");
  if (!isNext && !isPrevious) return undefined;
  const next = listSelectKey(key, { cursor: selected, count })?.cursor;
  if (next === undefined || !wrap || count <= 0) return next;
  if (isNext && selected === count - 1) return 0;
  if (isPrevious && selected === 0) return count - 1;
  return next;
}
