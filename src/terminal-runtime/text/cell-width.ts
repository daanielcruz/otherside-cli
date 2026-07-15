import emojiRegex from "emoji-regex";
import { eastAsianWidth } from "get-east-asian-width";
import stripAnsi from "strip-ansi";
import { getGraphemeSegmenter } from "@/utils/intl.js";

const EMOJI_REGEX = emojiRegex();

function stringWidthJavaScript(str: string): number {
  if (typeof str !== "string" || str.length === 0) {
    return 0;
  }

  let isPureAscii = true;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    if (code >= 127 || code === 0x1b) {
      isPureAscii = false;
      break;
    }
  }
  if (isPureAscii) {
    let width = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 0x1f) {
        width++;
      }
    }
    return width;
  }

  if (str.includes("\x1b")) {
    str = stripAnsi(str);
    if (str.length === 0) {
      return 0;
    }
  }

  if (!needsSegmentation(str)) {
    let width = 0;
    for (const char of str) {
      const codePoint = char.codePointAt(0)!;
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false });
      }
    }
    return width;
  }

  let width = 0;

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    EMOJI_REGEX.lastIndex = 0;
    if (EMOJI_REGEX.test(grapheme)) {
      width += getEmojiWidth(grapheme);
      continue;
    }

    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!;
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false });
        break;
      }
    }
  }

  return width;
}

function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!;

    if (cp >= 0x1f300 && cp <= 0x1faff) return true;
    if (cp >= 0x2600 && cp <= 0x27bf) return true;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;

    if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
    if (cp === 0x200d) return true;
  }
  return false;
}

function getEmojiWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0)!;
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0;
    for (const _ of grapheme) count++;
    return count === 1 ? 1 : 2;
  }

  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1);
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1;
    }
  }

  return 2;
}

function isZeroWidth(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint < 0x7f) return false;
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad;

  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;

  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff ||
    (codePoint >= 0x2060 && codePoint <= 0x2064)
  ) {
    return true;
  }

  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true;
  }

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true;
  }

  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    const offset = codePoint & 0x7f;
    if (offset <= 0x03) return true;
    if (offset >= 0x3a && offset <= 0x4f) return true;
    if (offset >= 0x51 && offset <= 0x57) return true;
    if (offset >= 0x62 && offset <= 0x63) return true;
  }

  if (
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    codePoint === 0x0eb1 ||
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) ||
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd)
  ) {
    return true;
  }

  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true;
  }

  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true;

  return false;
}

const bunStringWidth =
  typeof Bun !== "undefined" && typeof Bun.stringWidth === "function" ? Bun.stringWidth : null;

const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const;

export const stringWidth: (str: string) => number = bunStringWidth
  ? (str) => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
  : stringWidthJavaScript;
