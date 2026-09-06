import { eastAsianWidth } from "get-east-asian-width";
import stripAnsi from "strip-ansi";
import { sharedGraphemeSegmenter } from "@/kernel/std/intl.ts";

export interface StringWidthOptions {
  ambiguousIsNarrow?: boolean;
  countAnsiEscapeCodes?: boolean;
}

const BASIC_PRINTABLE_TEXT = /^[\u0020-\u007e]*$/;
const INVISIBLE_GRAPHEME =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+$/v;
const INVISIBLE_PREFIX =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const RENDERED_EMOJI = /^\p{RGI_Emoji}$/v;
const KEYCAP_SEQUENCE = /^[\d#*]\u20e3$/;
const PICTOGRAPH = /\p{Extended_Pictographic}/gu;
const C1_CSI = "\u009b";

const nativeCellWidth =
  typeof Bun !== "undefined" && typeof Bun.stringWidth === "function" ? Bun.stringWidth : null;

export function stringWidth(input: string, options: StringWidthOptions = {}): number {
  if (typeof input !== "string" || input.length === 0) return 0;

  const ambiguousIsNarrow = options.ambiguousIsNarrow ?? true;
  const countAnsiEscapeCodes = options.countAnsiEscapeCodes ?? false;
  const nativeCanHonorContract =
    nativeCellWidth !== null && ambiguousIsNarrow && !input.includes(C1_CSI);
  if (nativeCanHonorContract) {
    return nativeCellWidth(input, { countAnsiEscapeCodes });
  }

  const visibleText = countAnsiEscapeCodes ? input : removeTerminalSequences(input);
  return measureVisibleCells(visibleText, !ambiguousIsNarrow);
}

export function paintCellWidth(input: string): number {
  if (typeof input !== "string" || input.length === 0) return 0;
  // The paint contract counts an 8-bit CSI introducer as a zero-width cell and
  // its payload as text; native measurement drifts across runtime builds on
  // that byte, so C1 input always takes the deterministic path.
  if (nativeCellWidth !== null && !input.includes(C1_CSI)) {
    return nativeCellWidth(input, { ambiguousIsNarrow: true });
  }

  const visibleText = input.includes("\u001b") ? stripAnsi(input) : input;
  return measureVisibleCells(visibleText, false);
}

function removeTerminalSequences(input: string): string {
  if (!input.includes("\u001b") && !input.includes(C1_CSI)) return input;
  return stripAnsi(input);
}

function measureVisibleCells(input: string, ambiguousAsWide: boolean): number {
  if (input.length === 0) return 0;
  if (BASIC_PRINTABLE_TEXT.test(input)) return input.length;

  const widthOptions = { ambiguousAsWide };
  let cells = 0;
  for (const { segment } of sharedGraphemeSegmenter().segment(input)) {
    if (INVISIBLE_GRAPHEME.test(segment)) continue;
    if (RENDERED_EMOJI.test(segment) || isJoinedEmoji(segment)) {
      cells += 2;
      continue;
    }

    const firstVisibleCodePoint = segment.replace(INVISIBLE_PREFIX, "").codePointAt(0);
    if (firstVisibleCodePoint === undefined) continue;
    cells += eastAsianWidth(firstVisibleCodePoint, widthOptions);
    cells += trailingFullwidthCells(segment, widthOptions);
  }
  return cells;
}

function isJoinedEmoji(segment: string): boolean {
  if (segment.length > 50) return false;
  if (KEYCAP_SEQUENCE.test(segment)) return true;
  if (!segment.includes("\u200d")) return false;
  return (segment.match(PICTOGRAPH)?.length ?? 0) >= 2;
}

function trailingFullwidthCells(
  segment: string,
  widthOptions: { ambiguousAsWide: boolean },
): number {
  let cells = 0;
  for (const character of segment.slice(1)) {
    if (character < "\uff00" || character > "\uffef") continue;
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) cells += eastAsianWidth(codePoint, widthOptions);
  }
  return cells;
}
