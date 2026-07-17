import { eastAsianWidth } from "get-east-asian-width";
import stripAnsi from "strip-ansi";
import { getGraphemeSegmenter } from "@/kernel/std/intl.ts";

export interface StringWidthOptions {
  ambiguousIsNarrow?: boolean;
  countAnsiEscapeCodes?: boolean;
}

const printableAsciiRegex = /^[\u0020-\u007e]*$/;
const zeroWidthRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})+$/v;
const leadingZeroWidthRegex =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const emojiRegex = /^\p{RGI_Emoji}$/v;
const keycapRegex = /^[\d#*]\u20e3$/;
const pictographicRegex = /\p{Extended_Pictographic}/gu;

// The native width is the same measurement the paint layer uses for terminal
// cells, so buffer math (wrap points, cursor columns) stays in lockstep with
// the painted rows — and it is orders of magnitude faster than the JS walk on
// non-ASCII text (a hot path while typing). Resolved once at module scope; the
// JS walk below remains the fallback and the only implementation of the
// ambiguous-wide option, which the native call does not honor. The native
// scanner does not know the 8-bit CSI introducer, so those strings take the
// JS path where stripAnsi handles them.
const nativeWidth =
  typeof Bun !== "undefined" && typeof Bun.stringWidth === "function" ? Bun.stringWidth : null;

export function stringWidth(input: string, options: StringWidthOptions = {}): number {
  if (typeof input !== "string" || input.length === 0) return 0;

  const { ambiguousIsNarrow = true, countAnsiEscapeCodes = false } = options;
  if (nativeWidth && ambiguousIsNarrow && !input.includes("\u009b")) {
    return nativeWidth(input, { countAnsiEscapeCodes });
  }
  let text = input;
  if (!countAnsiEscapeCodes && (text.includes("\u001b") || text.includes("\u009b"))) {
    text = stripAnsi(text);
  }
  if (text.length === 0) return 0;
  if (printableAsciiRegex.test(text)) return text.length;

  const eastAsianOptions = { ambiguousAsWide: !ambiguousIsNarrow };
  let width = 0;
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    if (zeroWidthRegex.test(segment)) continue;
    if (emojiRegex.test(segment) || isUnqualifiedEmojiSequence(segment)) {
      width += 2;
      continue;
    }
    const visible = segment.replace(leadingZeroWidthRegex, "");
    const codePoint = visible.codePointAt(0);
    if (codePoint === undefined) continue;
    width += eastAsianWidth(codePoint, eastAsianOptions);
    width += trailingFormsWidth(segment, eastAsianOptions);
  }
  return width;
}

function isUnqualifiedEmojiSequence(segment: string): boolean {
  if (segment.length > 50) return false;
  if (keycapRegex.test(segment)) return true;
  if (!segment.includes("\u200d")) return false;
  const pictographics = segment.match(pictographicRegex);
  return (pictographics?.length ?? 0) >= 2;
}

function trailingFormsWidth(
  segment: string,
  eastAsianOptions: { ambiguousAsWide: boolean },
): number {
  let extra = 0;
  for (const char of segment.slice(1)) {
    if (char >= "\uff00" && char <= "\uffef") {
      const codePoint = char.codePointAt(0);
      if (codePoint !== undefined) extra += eastAsianWidth(codePoint, eastAsianOptions);
    }
  }
  return extra;
}

export default stringWidth;
