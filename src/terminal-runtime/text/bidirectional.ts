import bidiFactory from "bidi-js";

type TextSegment = {
  value: string;
  width: number;
  styleId: number;
  hyperlink: string | undefined;
};

let bidiInstance: ReturnType<typeof bidiFactory> | undefined;
let needsSoftwareBidi: boolean | undefined;

function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    needsSoftwareBidi =
      typeof process.env.WT_SESSION === "string" || process.env.TERM_PROGRAM === "vscode";
  }
  return needsSoftwareBidi;
}

function getBidi() {
  if (!bidiInstance) {
    bidiInstance = bidiFactory();
  }
  return bidiInstance;
}

export function normalizeTextDirection(characters: TextSegment[]): TextSegment[] {
  if (!needsBidi() || characters.length === 0) {
    return characters;
  }

  const plainText = characters
    .map((c) => c.value.replace(/[\u061C\u202A-\u202E\u2066-\u2069]/g, "\uFFFD"))
    .join("");

  if (!hasRTLCharacters(plainText)) {
    return characters;
  }

  const bidi = getBidi();
  const { levels } = bidi.getEmbeddingLevels(plainText, "auto");

  const charLevels: number[] = [];
  let offset = 0;
  for (let i = 0; i < characters.length; i++) {
    charLevels.push(levels[offset]!);
    offset += characters[i]!.value.length;
  }

  const reordered = [...characters];
  const maxLevel = Math.max(...charLevels);

  for (let level = maxLevel; level >= 1; level--) {
    let i = 0;
    while (i < reordered.length) {
      if (charLevels[i]! >= level) {
        let j = i + 1;
        while (j < reordered.length && charLevels[j]! >= level) {
          j++;
        }

        reverseRange(reordered, i, j - 1);
        reverseRangeNumbers(charLevels, i, j - 1);
        i = j;
      } else {
        i++;
      }
    }
  }

  return reordered;
}

function reverseRange<T>(arr: T[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!;
    arr[start] = arr[end]!;
    arr[end] = temp;
    start++;
    end--;
  }
}

function reverseRangeNumbers(arr: number[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!;
    arr[start] = arr[end]!;
    arr[end] = temp;
    start++;
    end--;
  }
}

function hasRTLCharacters(text: string): boolean {
  return /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/u.test(
    text,
  );
}
