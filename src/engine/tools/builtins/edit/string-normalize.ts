export const LEFT_SINGLE_CURLY_QUOTE = "‘";
export const RIGHT_SINGLE_CURLY_QUOTE = "’";
export const LEFT_DOUBLE_CURLY_QUOTE = "“";
export const RIGHT_DOUBLE_CURLY_QUOTE = "”";

export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part === undefined) continue;
    if (i % 2 === 0) {
      result += part.replace(/\s+$/, "");
    } else {
      result += part;
    }
  }
  return result;
}

export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
  return null;
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "—" ||
    prev === "–"
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE);
    } else {
      result.push(chars[i] ?? "");
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i] ?? "");
    }
  }
  return result.join("");
}

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;
  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  if (!hasDouble && !hasSingle) return newString;
  let result = newString;
  if (hasDouble) result = applyCurlyDoubleQuotes(result);
  if (hasSingle) result = applyCurlySingleQuotes(result);
  return result;
}

const DESANITIZATIONS: Record<string, string> = {
  "<fnr>": "<function_results>",
  "<n>": "<name>",
  "</n>": "</name>",
  "<o>": "<output>",
  "</o>": "</output>",
  "<e>": "<error>",
  "</e>": "</error>",
  "<s>": "<system>",
  "</s>": "</system>",
  "<r>": "<result>",
  "</r>": "</result>",
  "< META_START >": "<META_START>",
  "< META_END >": "<META_END>",
  "< EOT >": "<EOT>",
  "< META >": "<META>",
  "< SOS >": "<SOS>",
  "\n\nH:": "\n\nHuman:",
  "\n\nA:": "\n\nAssistant:",
};

export function desanitizeMatchString(matchString: string): {
  result: string;
  appliedReplacements: Array<{ from: string; to: string }>;
} {
  let result = matchString;
  const appliedReplacements: Array<{ from: string; to: string }> = [];
  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const before = result;
    result = result.replaceAll(from, to);
    if (before !== result) appliedReplacements.push({ from, to });
  }
  return { result, appliedReplacements };
}

export function normalizeEditStrings(params: {
  filePath: string;
  fileContent: string;
  oldString: string;
  newString: string;
}): { oldString: string; newString: string } {
  const { filePath, fileContent, oldString, newString } = params;
  const isMarkdown = /\.(md|mdx)$/i.test(filePath);
  const strippedNew = stripTrailingWhitespace(newString);
  // Stripping the model's accidental trailing whitespace must not silently
  // collapse a deliberate trailing-whitespace-only edit (old != new raw, but
  // equal once stripped) into a no-op — keep the raw new_string in that case.
  const normalizedNew = isMarkdown || strippedNew === oldString ? newString : strippedNew;

  if (fileContent.includes(oldString)) {
    return { oldString, newString: normalizedNew };
  }

  const actual = findActualString(fileContent, oldString);
  if (actual !== null && actual !== oldString) {
    const preserved = preserveQuoteStyle(oldString, actual, normalizedNew);
    return { oldString: actual, newString: preserved };
  }

  const { result: desanitized, appliedReplacements } = desanitizeMatchString(oldString);
  if (appliedReplacements.length > 0 && fileContent.includes(desanitized)) {
    // Desanitize new_string on its OWN markers, not only the ones old_string
    // happened to carry — otherwise a marker present only in new_string (e.g.
    // `<n>`) would be written to the file still sanitized.
    return { oldString: desanitized, newString: desanitizeMatchString(normalizedNew).result };
  }

  return { oldString, newString: normalizedNew };
}
