import { parseBindings } from "./parser.ts";
import type { KeybindingBlock, ParsedBinding } from "./types.ts";

const BLOCKS: KeybindingBlock[] = [
  {
    context: "Global",
    bindings: {
      escape: "overlay:dismiss",
    },
  },
  {
    context: "Overlay:help",
    bindings: {
      left: "overlay:dismiss",
      "ctrl+c": "overlay:dismiss",
    },
  },
  {
    context: "PanelDefaults",
    bindings: {
      up: "panel:up",
      down: "panel:down",
      left: "panel:left",
      right: "panel:right",
      tab: "panel:tab",
      "shift+tab": "panel:shiftTab",
      return: "panel:enter",
      q: "panel:back",
    },
  },
];

export const defaultBindings: ParsedBinding[] = parseBindings(BLOCKS);
