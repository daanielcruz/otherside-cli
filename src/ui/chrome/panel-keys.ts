import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { lookupKey } from "@/ui/keys/resolver.ts";

/**
 * What every panel answers to beyond its list: take the row, move between levels,
 * leave, and toggle what the cursor is on.
 *
 * Which key does which is the binding table's answer, the way it already is for
 * list navigation — so a panel writes what a key MEANS and rebinding moves every
 * panel at once. A panel that has no back level or nothing to toggle simply does
 * not act on those.
 *
 * A context that claims a key first keeps it: a config row steps its value with the
 * arrows, so `config` answers them before `panel` would read them as levels.
 */
export type PanelKeyAction = "confirm" | "back" | "forward" | "close" | "toggle";

export function panelKey(key: KeyEventData): PanelKeyAction | undefined {
  // Chordless: a panel binds no multi-step chord, and the chord-aware resolver
  // spends a live prefix on every press it sees.
  const resolved = lookupKey({ key, contexts: ["panel"] });
  if (resolved.kind !== "action") return undefined;
  switch (resolved.action) {
    case "panel:confirm":
      return "confirm";
    case "panel:back":
      return "back";
    case "panel:forward":
      return "forward";
    case "panel:close":
      return "close";
    case "panel:toggle":
      return "toggle";
    default:
      return undefined;
  }
}

/**
 * Whether a press means "leave where I am" — the leave key, or the back key on a
 * surface with no level to go back to. Panels that have levels let their own back
 * handler decide whether that pops one or closes; this only says the press asked.
 */
export function panelLeaves(key: KeyEventData): boolean {
  const action = panelKey(key);
  return action === "close" || action === "back";
}
