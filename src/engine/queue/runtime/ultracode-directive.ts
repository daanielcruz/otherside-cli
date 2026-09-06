type TextSpan = { start: number; end: number };
type WrappedTextStart = TextSpan & { opener: string };

const CLOSING_DELIMITER: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

const BLOCKED_ADJACENT_CHARACTER = new Set(["/", "\\", "-"]);
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const ULTRACODE_OCCURRENCE = /\bultracode\b/gi;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

function findWrappedTextStart(text: string, from: number): WrappedTextStart | null {
  for (let index = from; index < text.length; index++) {
    const opener = text[index]!;
    if (CLOSING_DELIMITER[opener] === undefined) continue;
    if (opener === "<" && !/[a-zA-Z/]/.test(text[index + 1] ?? "")) continue;
    if (opener === "'" && isWordCharacter(text[index - 1])) continue;
    return { opener, start: index, end: index + 1 };
  }
  return null;
}

function findApostropheEnd(text: string, from: number): number {
  let index = text.indexOf("'", from);
  while (index !== -1 && isWordCharacter(text[index + 1])) {
    index = text.indexOf("'", index + 1);
  }
  return index;
}

function closeWrappedText(text: string, start: WrappedTextStart): TextSpan | null {
  const closingIndex =
    start.opener === "'"
      ? findApostropheEnd(text, start.end)
      : text.indexOf(CLOSING_DELIMITER[start.opener]!, start.end);
  if (closingIndex === -1) return null;

  return {
    start:
      start.opener === "["
        ? Math.max(start.start, text.lastIndexOf("[", closingIndex))
        : start.start,
    end: closingIndex + 1,
  };
}

function closedWrappedTextSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = findWrappedTextStart(text, cursor);
    if (start === null) break;
    const span = closeWrappedText(text, start);
    if (span === null) break;
    spans.push(span);
    cursor = span.end;
  }
  return spans;
}

function isDirectiveOccurrence(
  text: string,
  start: number,
  end: number,
  wrappedText: TextSpan[],
): boolean {
  if (wrappedText.some((span) => start >= span.start && start < span.end)) return false;

  const before = text[start - 1];
  const after = text[end];
  if (before !== undefined && BLOCKED_ADJACENT_CHARACTER.has(before)) return false;
  if (after !== undefined && BLOCKED_ADJACENT_CHARACTER.has(after)) return false;
  if (after === "?") return false;
  return after !== "." || !isWordCharacter(text[end + 1]);
}

/**
 * Where the keyword asks for orchestration, as spans into the text.
 *
 * The same reading the turn does, so what a draft lights is exactly what would
 * opt it in — a word inside quotes or a path is neither lit nor counted.
 */
export function ultracodeKeywordSpans(text: string): { start: number; end: number }[] {
  if (text.startsWith("/")) return [];
  const wrappedText = closedWrappedTextSpans(text);
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(ULTRACODE_OCCURRENCE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isDirectiveOccurrence(text, start, end, wrappedText)) spans.push({ start, end });
  }
  return spans;
}

export function hasUltracodeKeyword(text: string): boolean {
  return ultracodeKeywordSpans(text).length > 0;
}
