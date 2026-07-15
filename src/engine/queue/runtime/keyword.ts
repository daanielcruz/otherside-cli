type TriggerPosition = { word: string; start: number; end: number };

const OPEN_TO_CLOSE: Record<string, string> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

const ULTRACODE_KEYWORD = "ultracode";

function findKeywordTriggerPositions(text: string, keyword: string): TriggerPosition[] {
  const re = new RegExp(keyword, "i");
  if (!re.test(text)) return [];
  if (text.startsWith("/")) return [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  let openQuote: string | null = null;
  let openAt = 0;
  const isWord = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (openQuote) {
      if (openQuote === "[" && ch === "[") {
        openAt = i;
        continue;
      }
      if (ch !== OPEN_TO_CLOSE[openQuote]) continue;
      if (openQuote === "'" && isWord(text[i + 1])) continue;
      quotedRanges.push({ start: openAt, end: i + 1 });
      openQuote = null;
    } else if (
      (ch === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
      (ch === "'" && !isWord(text[i - 1])) ||
      (ch !== "<" && ch !== "'" && ch in OPEN_TO_CLOSE)
    ) {
      openQuote = ch;
      openAt = i;
    }
  }
  const positions: TriggerPosition[] = [];
  const wordRe = new RegExp(`\\b${keyword}\\b`, "gi");
  for (const match of text.matchAll(wordRe)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (quotedRanges.some((r) => start >= r.start && start < r.end)) continue;
    const before = text[start - 1];
    const after = text[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && isWord(text[end + 1])) continue;
    positions.push({ word: match[0], start, end });
  }
  return positions;
}

export function hasUltracodeKeyword(text: string): boolean {
  return findKeywordTriggerPositions(text, ULTRACODE_KEYWORD).length > 0;
}
