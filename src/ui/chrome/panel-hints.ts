import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { Glyph } from "@/ui/theme/theme.ts";

/**
 * The footer-hint vocabulary: one home for the joiner, chord formatting, and the
 * recurring action hints, so every panel footer phrases the same action the same
 * way. Builders return plain text; the panel builder renders hint lines muted.
 */

/** ` · ` — separates adjacent hints on a footer line. */
export const HINT_JOINER = Glyph.divider;

export interface PanelHint {
  /** Keys that trigger the action, in display order, e.g. `["enter", Glyph.arrowDown]`. */
  keys: readonly string[];
  label: string;
}

/**
 * Recurring footer actions with their default chords; the SoT for hint phrasing.
 * Spellings pinned by a live 2.1.220 capture: key names capitalize (`Enter`,
 * `Space`, `Type`, `Esc`), arrows stay glyphs, chords join with `/`.
 *
 * An action appears ONCE. Entries that named the same keys and the same label
 * under a second spelling meant a binding change had to be made in two or three
 * places to keep the footers agreeing, which is the opposite of what this file is
 * for. Two entries sharing a key but not a label are different actions and stay.
 */
export const HINT_ACTION_SPECS = {
  close: { keys: ["Esc"], label: "to close" },
  back: { keys: ["Esc"], label: "to go back" },
  cancel: { keys: ["Esc"], label: "to cancel" },
  select: { keys: ["Enter", Glyph.arrowDown], label: "to select" },
  details: { keys: ["Enter"], label: "for details" },
  search: { keys: ["/"], label: "to search" },
  switch: { keys: [Glyph.arrowLeft, Glyph.arrowRight, "tab"], label: "to switch" },
  change: { keys: ["Enter", "Space"], label: "to change" },
  cycle: { keys: ["Enter", "Space"], label: "to cycle" },
  sort: { keys: ["t"], label: "to sort" },
  clear: { keys: ["Esc"], label: "to clear" },
  return: { keys: [Glyph.arrowDown], label: "to return" },
  tabs: { keys: [Glyph.arrowUp], label: "to tabs" },
  install: { keys: ["i"], label: "to install" },
  typeToSearch: { keys: ["Type"], label: "to search" },
  typeToFilter: { keys: ["Type"], label: "to filter" },
  spaceToggle: { keys: ["Space"], label: "to toggle" },
  favorite: { keys: ["f"], label: "to favorite" },
  update: { keys: ["u"], label: "to update" },
  remove: { keys: ["d"], label: "to remove" },
  enterResume: { keys: ["Enter"], label: "to resume" },
  enterContinue: { keys: ["Enter"], label: "to continue" },
  enterSelect: { keys: ["Enter"], label: "to select" },
  enterSave: { keys: ["Enter"], label: "to save" },
  spacePreview: { keys: ["Space"], label: "to preview" },
  rename: { keys: ["Ctrl+R"], label: "to rename" },
  edit: { keys: ["Ctrl+E"], label: "to edit" },
  arrowsScroll: { keys: [`${Glyph.arrowUp}${Glyph.arrowDown}`], label: "to scroll" },
  pageScroll: { keys: ["PgUp", "PgDn"], label: "to page" },
  refresh: { keys: ["r"], label: "to refresh" },
  enterView: { keys: ["Enter"], label: "to view" },
  xStop: { keys: ["x"], label: "to stop" },
  xClear: { keys: ["x"], label: "to clear" },
  stopAllAgents: { keys: ["ctrl+x ctrl+k"], label: "to stop all agents" },
  arrowsSelect: { keys: [Glyph.arrowUp, Glyph.arrowDown], label: "to select" },
  xPause: { keys: ["x"], label: "to pause" },
  xKill: { keys: ["x"], label: "to kill" },
  sSave: { keys: ["s"], label: "to save" },
} as const satisfies Record<string, PanelHint>;

export type HintAction = keyof typeof HINT_ACTION_SPECS;

export function hintFor(action: HintAction): PanelHint {
  return HINT_ACTION_SPECS[action];
}

/** `enter/↓` — every key of a chord, joined for display. */
export function hintChord(keys: readonly string[]): string {
  return keys.join("/");
}

/** `enter/↓ to select` — one formatted hint. */
export function formatHint(hint: PanelHint): string {
  return `${hintChord(hint.keys)} ${hint.label}`;
}

/** One hint in the panel spec's `[chord, label]` pair shape. */
export function hintPair(hint: PanelHint): [string, string] {
  return [hintChord(hint.keys), hint.label];
}

/**
 * Formatted hints joined with {@link HINT_JOINER}, greedily wrapped to `width`
 * when one is given. A hint never breaks internally; a hint wider than the
 * width takes a line of its own.
 */
export function hintLines(hints: readonly PanelHint[], width?: number): string[] {
  const parts = hints.map(formatHint);
  if (parts.length === 0) return [];
  if (width === undefined) return [parts.join(HINT_JOINER)];

  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const joined = line.length === 0 ? part : line + HINT_JOINER + part;
    if (line.length > 0 && stringWidth(joined) > width) {
      lines.push(line);
      line = part;
    } else {
      line = joined;
    }
  }
  lines.push(line);
  return lines;
}
