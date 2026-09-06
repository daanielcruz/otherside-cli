import { wrapIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";

/**
 * Focus-model key handling for the panel tab row. The rendering half of the
 * contract lives in the panel builder (`headerFocused` on FooterPanelSpec); this
 * half owns which keys move the active tab so every header cycles the same way.
 */

/**
 * Next active tab for a key while the header holds focus. Tab and right cycle
 * forward, shift+tab and left cycle backward, all with wrap-around. Answers
 * undefined when the header is unfocused or the key does not cycle tabs, so the
 * caller falls through to its own handling.
 */
export function cycleTabForKey(input: {
  key: KeyEventData;
  activeTab: number;
  tabCount: number;
  headerFocused: boolean;
}): number | undefined {
  const { key, activeTab, tabCount, headerFocused } = input;
  if (!headerFocused || tabCount <= 0) return undefined;
  if (key.ctrl || key.meta) return undefined;
  if (key.name === "tab") return wrapIndex(activeTab + (key.shift ? -1 : 1), tabCount);
  if (key.name === "right") return wrapIndex(activeTab + 1, tabCount);
  if (key.name === "left") return wrapIndex(activeTab - 1, tabCount);
  return undefined;
}
