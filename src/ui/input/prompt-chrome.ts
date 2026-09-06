import { lookup } from "@/commands/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { CaretPosition } from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalTextStyle } from "@/terminal-runtime/text/style-model.js";
import { effortStatuslineSuffix } from "@/ui/chrome/status/line-input.ts";
import type { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import type { PromptDisplayRow } from "@/ui/input/prompt-text.js";
import type { VimMode } from "@/ui/input/vim/types.ts";
import { effortColor } from "@/ui/theme/effort-color.ts";
import { Color, type ColorValue, Glyph } from "@/ui/theme/theme.ts";

/**
 * The prompt's visual chrome: rules, header tabs, caret cell, command
 * highlighting and the stand-in row. Pure text producers — the prompt
 * component owns state and composes these into its frame.
 */

export const CONTINUATION_PREFIX = "  ";
/** The top rule sits above the input, so a content row is offset by it. */
export const TOP_RULE_ROWS = 1;
const TRAILING_RULE_CELLS = 1;
// Software block cursor: reverse-video the cell the caret sits on. The host
// keeps the hardware cursor hidden, so this is the only caret the user sees.
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

export type PromptRouteState = ReturnType<typeof readStringViewBrokerState>;

/**
 * The cell the caret occupies, counted in display columns from the row's left edge:
 * the row's own prefix, then the text standing before the caret.
 */
export function caretInRows(
  rows: readonly PromptDisplayRow[],
  bashMode: boolean,
): CaretPosition | null {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined || row.cursorOffset === null) continue;
    const prefix = index === 0 ? (bashMode ? "!\u00A0" : Glyph.promptChevron) : CONTINUATION_PREFIX;
    return {
      row: TOP_RULE_ROWS + index,
      column: stringWidth(prefix) + stringWidth(row.text.slice(0, row.cursorOffset)),
    };
  }
  return null;
}

/**
 * Placeholder shown after a completed slash command token when the user has typed
 * trailing whitespace but no argument yet (e.g. `/fork ` → `<directive>`).
 */
export function slashArgumentHint(text: string, bashMode: boolean): string | null {
  if (bashMode || !text.startsWith("/")) return null;
  const slashQuery = text.slice(1);
  if (!/\s/.test(slashQuery)) return null;
  const commandToken = slashQuery.split(/\s+/, 1)[0] ?? "";
  const command = lookup(commandToken);
  if (!command?.argumentHint) return null;
  const remainder = slashQuery.split(/\s+/, 2)[1] ?? "";
  if (remainder.length > 0) return null;
  return command.argumentHint;
}

/**
 * The chevron, then a dimmed stand-in whose first cell carries the caret. That cell
 * belongs to the same muted phrase as the rest — only the inversion is the caret's, so
 * an unlit caret leaves the phrase evenly coloured instead of lighting its first letter.
 */
export function standInRow(text: string, caretLit: boolean): string {
  const muted = { color: Color.muted, dim: true } as const;
  return (
    renderTextWithStyles(Glyph.promptChevron, runningRef.current ? { color: Color.muted } : {}) +
    renderTextWithStyles(text.slice(0, 1), caretLit ? { ...muted, inverse: true } : muted) +
    renderTextWithStyles(text.slice(1), muted)
  );
}

/**
 * The caret cell. An unlit caret keeps its character and its column — only the
 * inversion goes — so the row's width never depends on where attention is.
 */
function litCaretCell(char: string, lit: boolean): string {
  return lit ? INVERSE_ON + char + INVERSE_OFF : char;
}

/**
 * A character span of the prompt text carrying its own styles: dictation renders
 * its interim text dim, a modal selection renders inverse. One span type rather
 * than one per purpose, so the walk that applies it stays a single walk.
 */
export interface PromptStyledRange {
  start: number;
  end: number;
  styles: TerminalTextStyle;
}

/** A cell drawn in the caret's place with its own glyph and colour. */
export interface PromptCaretOverride {
  char: string;
  color: ColorValue;
}

/**
 * A prompt text segment styled for display: the command token lit, and the slice
 * inside `styled` wearing whatever styles that span asked for.
 */
function promptSpan(
  segment: string,
  segmentStart: number,
  commandTokenLength: number,
  styled: readonly PromptStyledRange[],
): string {
  if (styled.length === 0 || segment.length === 0) {
    return commandLitSpan(segment, segmentStart, commandTokenLength);
  }
  let out = "";
  let cursor = 0;
  for (const range of styled) {
    const from = Math.max(cursor, Math.min(segment.length, range.start - segmentStart));
    const to = Math.max(from, Math.min(segment.length, range.end - segmentStart));
    if (to <= from) continue;
    if (from > cursor) {
      out += commandLitSpan(segment.slice(cursor, from), segmentStart + cursor, commandTokenLength);
    }
    out += renderTextWithStyles(segment.slice(from, to), range.styles);
    cursor = to;
  }
  return out + commandLitSpan(segment.slice(cursor), segmentStart + cursor, commandTokenLength);
}

/**
 * The typed buffer as display rows: the chevron (or shell prefix) on the head
 * row, continuation padding under it, the command token lit, the caret cell
 * inverted while lit, and the argument hint riding the caret's row.
 */
export function promptContentRows(input: {
  rows: readonly PromptDisplayRow[];
  bashMode: boolean;
  commandTokenLength: number;
  argHint: string | null;
  caretLit: boolean;
  /**
   * Spans of the display text wearing their own styles, in order and without
   * overlap — one draft can carry several (every keyword occurrence).
   */
  styledRanges?: readonly PromptStyledRange[];
  /** Replaces the caret cell (the live voice meter rides the caret's column). */
  caretOverride?: PromptCaretOverride | null;
}): string[] {
  const {
    rows,
    bashMode,
    commandTokenLength,
    argHint,
    caretLit,
    styledRanges = [],
    caretOverride = null,
  } = input;
  return rows.map((row, index) => {
    const prefix =
      index === 0
        ? renderTextWithStyles(
            bashMode ? "!\u00A0" : Glyph.promptChevron,
            // The chevron rides the terminal's own foreground and goes
            // muted while a turn is running; the shell-mode prefix
            // glyph stays uncolored (only its hint carries the colour).
            !bashMode && runningRef.current ? { color: Color.muted } : {},
          )
        : CONTINUATION_PREFIX;
    // The row's own offset, not a running sum of row lengths: a wrap drops the
    // character it broke on, so summing lengths puts every later row a column
    // early and shifts what a styled range lands on.
    const rowStart = row.start;
    if (row.cursorOffset === null) {
      return prefix + promptSpan(row.text, rowStart, commandTokenLength, styledRanges);
    }
    const before = promptSpan(
      row.text.slice(0, row.cursorOffset),
      rowStart,
      commandTokenLength,
      styledRanges,
    );
    const caretCell =
      caretOverride !== null
        ? renderTextWithStyles(caretOverride.char, { color: caretOverride.color })
        : litCaretCell(row.cursorChar.length > 0 ? row.cursorChar : " ", caretLit);
    const after = promptSpan(
      row.text.slice(row.cursorOffset + row.cursorChar.length),
      rowStart + row.cursorOffset + row.cursorChar.length,
      commandTokenLength,
      styledRanges,
    );
    // Argument hint rides the last cursor-owning row, after trailing text.
    const hintAfter =
      argHint !== null && index === rows.length - 1
        ? renderTextWithStyles(argHint, { color: Color.subtle })
        : "";
    return prefix + before + caretCell + after + hintAfter;
  });
}

/**
 * Length of the leading `/command` token when it resolves to a real command;
 * 0 otherwise. Partial or unknown tokens stay unpainted.
 */
export function validCommandTokenLength(text: string, bashMode: boolean): number {
  if (bashMode || !text.startsWith("/")) return 0;
  const token = text.split(/\s/, 1)[0] ?? "";
  if (token.length < 2) return 0;
  return lookup(token.slice(1)) !== undefined ? token.length : 0;
}

/**
 * Row text with the slice inside the valid command token lit in the highlight
 * colour. `segmentStart` is the segment's offset into the full prompt text.
 */
export function commandLitSpan(segment: string, segmentStart: number, tokenLength: number): string {
  if (tokenLength <= segmentStart || segment.length === 0) return segment;
  const litEnd = Math.min(tokenLength - segmentStart, segment.length);
  return (
    renderTextWithStyles(segment.slice(0, litEnd), { color: Color.highlight }) +
    segment.slice(litEnd)
  );
}

type PromptHeaderTab = { bytes: string; cells: number };

/** A plain horizontal stroke spanning the prompt width. */
export function renderPromptStroke(columns: number, color: ColorValue = Color.border): string {
  return renderTextWithStyles(Glyph.boxHLine.repeat(Math.max(0, columns)), { color });
}

/** What the announcement calls each mode. Visual names its span; the rest stand alone. */
function vimModeLabel(mode: VimMode): string {
  if (mode.name === "insert") return "INSERT";
  if (mode.name === "normal") return "NORMAL";
  return mode.span === "linewise" ? "VISUAL LINE" : "VISUAL";
}

/**
 * How an editor mode announces itself, or null when there is nothing to announce.
 * Plain text: the status row it rides on owns how chrome is coloured.
 */
export function editorModeAnnouncement(mode: VimMode | null): string | null {
  return mode === null ? null : `-- ${vimModeLabel(mode)} --`;
}

/** Places prompt history and route identity directly into the input's upper stroke. */
export function renderPromptHeader(
  width: number,
  route: PromptRouteState,
  history: { offset: number; total: number } | null,
  agentIdentity: string | null,
  color: ColorValue = Color.border,
): string {
  const columns = Math.max(0, width);
  const historyLabel = history === null ? "" : ` History ${history.offset}/${history.total} `;
  const historyInset = history === null ? 0 : 3;
  const trailingTab = agentIdentity === null ? effortTab(route) : addresseeTab(agentIdentity);
  const trailingInset = trailingTab === undefined ? 0 : TRAILING_RULE_CELLS;
  const strokeCells =
    columns - historyInset - stringWidth(historyLabel) - (trailingTab?.cells ?? 0) - trailingInset;
  if (strokeCells < 0) return renderPromptStroke(columns, color);

  const stroke = (cells: number): string =>
    renderTextWithStyles(Glyph.boxHLine.repeat(cells), { color });
  return (
    stroke(historyInset) +
    renderTextWithStyles(historyLabel, { color: Color.muted }) +
    stroke(strokeCells) +
    (trailingTab?.bytes ?? "") +
    stroke(trailingInset)
  );
}

function effortTab(route: PromptRouteState): PromptHeaderTab | undefined {
  if (effortStatuslineSuffix(route) === null || !route.effort) return undefined;
  const effort = route.effort;
  return {
    bytes: ` ${renderTextWithStyles(effort, { color: effortColor(effort), bold: true })} `,
    cells: stringWidth(effort) + 2,
  };
}

function addresseeTab(identity: string): PromptHeaderTab {
  return {
    bytes: renderTextWithStyles(` ${identity} `, {
      color: Color.tabSelectedText,
      backgroundColor: Color.primary,
    }),
    cells: stringWidth(identity) + 2,
  };
}
