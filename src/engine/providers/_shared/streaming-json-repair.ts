export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

const JSON_LITERAL_NAMES = ["true", "false", "null"] as const;
type JsonLiteralName = (typeof JSON_LITERAL_NAMES)[number];

type JsonFragment =
  | { role: "object-boundary"; source: "{" | "}" }
  | { role: "array-boundary"; source: "[" | "]" }
  | { role: "key-boundary"; source: ":" }
  | { role: "item-boundary"; source: "," }
  | { role: "quoted-value"; source: string }
  | { role: "numeric-value"; source: string }
  | { role: "literal-value"; source: JsonLiteralName };

type FragmentRead = {
  nextOffset: number;
  fragment?: JsonFragment;
};

const FIXED_FRAGMENT_BY_CHARACTER: Readonly<Record<string, JsonFragment | undefined>> = {
  "{": { role: "object-boundary", source: "{" },
  "}": { role: "object-boundary", source: "}" },
  "[": { role: "array-boundary", source: "[" },
  "]": { role: "array-boundary", source: "]" },
  ":": { role: "key-boundary", source: ":" },
  ",": { role: "item-boundary", source: "," },
};
const JSON_LITERAL_NAME_SET: ReadonlySet<string> = new Set(JSON_LITERAL_NAMES);
const DIGIT_CHARACTER = /[0-9]/;
const LETTER_CHARACTER = /[a-z]/i;
const WHITESPACE_CHARACTER = /\s/;

export function parseJsonWithPartialRecovery(input: string): JsonParseResult {
  const direct = parseJson(input);
  if (direct.ok) return direct;
  return parseJson(buildRecoverableJson(input));
}

function parseJson(input: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

function buildRecoverableJson(input: string): string {
  const fragments = retainCompletePrefix(readJsonFragments(input));
  const body = fragments.map((fragment) => fragment.source).join("");
  return body + missingContainerSuffix(fragments);
}

function readJsonFragments(input: string): JsonFragment[] {
  const fragments: JsonFragment[] = [];
  let offset = 0;
  while (offset < input.length) {
    const read = readJsonFragment(input, offset);
    offset = read.nextOffset;
    if (read.fragment) fragments.push(read.fragment);
  }
  return fragments;
}

function readJsonFragment(input: string, offset: number): FragmentRead {
  const character = input[offset]!;
  if (character === "\\") return { nextOffset: offset + 1 };

  const fixed = FIXED_FRAGMENT_BY_CHARACTER[character];
  if (fixed) return { nextOffset: offset + 1, fragment: fixed };
  if (character === '"') return readQuotedFragment(input, offset);
  if (WHITESPACE_CHARACTER.test(character)) return { nextOffset: offset + 1 };
  if (isNumericStart(character)) return readNumericFragment(input, offset);
  if (LETTER_CHARACTER.test(character)) return readLiteralFragment(input, offset);
  return { nextOffset: offset + 1 };
}

function readQuotedFragment(input: string, startOffset: number): FragmentRead {
  let offset = startOffset + 1;
  while (offset < input.length) {
    const character = input[offset]!;
    if (character === '"') {
      return {
        nextOffset: offset + 1,
        fragment: { role: "quoted-value", source: input.slice(startOffset, offset + 1) },
      };
    }
    if (character === "\\") {
      if (offset + 1 >= input.length) return { nextOffset: input.length };
      offset += 2;
      continue;
    }
    offset += 1;
  }
  return { nextOffset: input.length };
}

function isNumericStart(character: string): boolean {
  return DIGIT_CHARACTER.test(character) || character === "-" || character === ".";
}

function readNumericFragment(input: string, startOffset: number): FragmentRead {
  let offset = startOffset;
  if (input[offset] === "-") offset += 1;
  while (offset < input.length) {
    const character = input[offset]!;
    if (!DIGIT_CHARACTER.test(character) && character !== ".") break;
    offset += 1;
  }
  return {
    nextOffset: offset,
    fragment: { role: "numeric-value", source: input.slice(startOffset, offset) },
  };
}

function readLiteralFragment(input: string, startOffset: number): FragmentRead {
  let offset = startOffset;
  while (offset < input.length && LETTER_CHARACTER.test(input[offset]!)) offset += 1;
  const source = input.slice(startOffset, offset);
  if (isJsonLiteralName(source)) {
    return { nextOffset: offset, fragment: { role: "literal-value", source } };
  }
  return { nextOffset: offset + 1 };
}

function isJsonLiteralName(value: string): value is JsonLiteralName {
  return JSON_LITERAL_NAME_SET.has(value);
}

function retainCompletePrefix(fragments: JsonFragment[]): JsonFragment[] {
  let end = fragments.length;
  while (end > 0 && tailIsIncomplete(fragments, end)) end -= 1;
  return fragments.slice(0, end);
}

function tailIsIncomplete(fragments: JsonFragment[], end: number): boolean {
  const tail = fragments[end - 1]!;
  if (tail.role === "key-boundary" || tail.role === "item-boundary") return true;
  if (tail.role === "numeric-value") {
    return tail.source.endsWith(".") || tail.source.endsWith("-");
  }
  if (tail.role !== "quoted-value") return false;

  const previous = fragments[end - 2];
  return (
    previous?.role === "item-boundary" ||
    (previous?.role === "object-boundary" && previous.source === "{")
  );
}

function missingContainerSuffix(fragments: JsonFragment[]): string {
  const requiredClosers: Array<"}" | "]"> = [];
  for (const fragment of fragments) {
    if (fragment.role === "object-boundary" || fragment.role === "array-boundary") {
      updateRequiredClosers(requiredClosers, fragment.source);
    }
  }

  let suffix = "";
  while (requiredClosers.length > 0) suffix += requiredClosers.pop();
  return suffix;
}

function updateRequiredClosers(
  requiredClosers: Array<"}" | "]">,
  boundary: "{" | "}" | "[" | "]",
): void {
  const closer = boundary === "{" || boundary === "}" ? "}" : "]";
  if (boundary === "{" || boundary === "[") {
    requiredClosers.push(closer);
    return;
  }

  const matchingIndex = requiredClosers.lastIndexOf(closer);
  if (matchingIndex >= 0) requiredClosers.splice(matchingIndex, 1);
  else requiredClosers.pop();
}
