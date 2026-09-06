const TYPOGRAPHIC_TO_PLAIN = new Map<string, string>([
  ["‘", "'"],
  ["’", "'"],
  ["“", '"'],
  ["”", '"'],
]);

const EDIT_TEXT_DECODINGS = [
  ["<fnr>", "<function_results>"],
  ["<n>", "<name>"],
  ["</n>", "</name>"],
  ["<o>", "<output>"],
  ["</o>", "</output>"],
  ["<e>", "<error>"],
  ["</e>", "</error>"],
  ["<s>", "<system>"],
  ["</s>", "</system>"],
  ["<r>", "<result>"],
  ["</r>", "</result>"],
  ["< META_START >", "<META_START>"],
  ["< META_END >", "<META_END>"],
  ["< EOT >", "<EOT>"],
  ["< META >", "<META>"],
  ["< SOS >", "<SOS>"],
  ["\n\nH:", "\n\nHuman:"],
  ["\n\nA:", "\n\nAssistant:"],
] as const;

interface EditTextPair {
  oldString: string;
  newString: string;
}

function plainTypography(text: string): string {
  return text.replace(/[‘’“”]/g, (character) => TYPOGRAPHIC_TO_PLAIN.get(character) ?? character);
}

function removeLineEndSpacing(text: string): string {
  return text.replace(/[^\S\r\n]+(?=\r\n|\r|\n|$)/g, "");
}

function correspondingTypography(fileContent: string, requested: string): string | null {
  if (fileContent.includes(requested)) return requested;
  const start = plainTypography(fileContent).indexOf(plainTypography(requested));
  return start < 0 ? null : fileContent.substring(start, start + requested.length);
}

function followsOpeningBoundary(characters: string[], position: number): boolean {
  if (position === 0) return true;
  return " \t\n\r([{—–".includes(characters[position - 1] ?? "");
}

function applyDocumentTypography(template: string, replacement: string): string {
  const useDoubleTypography = template.includes("“") || template.includes("”");
  const useSingleTypography = template.includes("‘") || template.includes("’");
  if (!useDoubleTypography && !useSingleTypography) return replacement;

  const characters = [...replacement];
  return characters
    .map((character, position) => {
      if (character === '"' && useDoubleTypography) {
        return followsOpeningBoundary(characters, position) ? "“" : "”";
      }
      if (character !== "'" || !useSingleTypography) return character;
      const previous = characters[position - 1];
      const following = characters[position + 1];
      const betweenLetters =
        previous !== undefined &&
        following !== undefined &&
        /\p{L}/u.test(previous) &&
        /\p{L}/u.test(following);
      return betweenLetters || !followsOpeningBoundary(characters, position) ? "’" : "‘";
    })
    .join("");
}

function decodeProtectedEditText(text: string): { text: string; changed: boolean } {
  let decoded = text;
  let changed = false;
  for (const [protectedText, restoredText] of EDIT_TEXT_DECODINGS) {
    if (!decoded.includes(protectedText)) continue;
    decoded = decoded.replaceAll(protectedText, restoredText);
    changed = true;
  }
  return { text: decoded, changed };
}

export function normalizeEditStrings(params: {
  filePath: string;
  fileContent: string;
  oldString: string;
  newString: string;
}): EditTextPair {
  const { filePath, fileContent, oldString, newString } = params;
  const strippedNew = removeLineEndSpacing(newString);
  const editReplacement =
    /\.(md|mdx)$/i.test(filePath) || strippedNew === oldString ? newString : strippedNew;

  if (fileContent.includes(oldString)) return { oldString, newString: editReplacement };

  const typographicMatch = correspondingTypography(fileContent, oldString);
  if (typographicMatch !== null && typographicMatch !== oldString) {
    return {
      oldString: typographicMatch,
      newString: applyDocumentTypography(typographicMatch, editReplacement),
    };
  }

  const decodedOld = decodeProtectedEditText(oldString);
  if (decodedOld.changed && fileContent.includes(decodedOld.text)) {
    return {
      oldString: decodedOld.text,
      newString: decodeProtectedEditText(editReplacement).text,
    };
  }

  return { oldString, newString: editReplacement };
}
