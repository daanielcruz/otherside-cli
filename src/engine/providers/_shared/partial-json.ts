export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

type PartialJsonToken =
  | { type: "brace"; value: "{" | "}" }
  | { type: "paren"; value: "[" | "]" }
  | { type: "separator"; value: ":" }
  | { type: "delimiter"; value: "," }
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "name"; value: "true" | "false" | "null" };

export function parseJsonWithPartialRecovery(input: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    try {
      return { ok: true, value: parsePartialJSON(input) };
    } catch {
      return { ok: false };
    }
  }
}

function tokenizePartialJSON(input: string): PartialJsonToken[] {
  let index = 0;
  const tokens: PartialJsonToken[] = [];
  while (index < input.length) {
    let char = input[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "brace", value: "{" });
      index++;
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "brace", value: "}" });
      index++;
      continue;
    }
    if (char === "[") {
      tokens.push({ type: "paren", value: "[" });
      index++;
      continue;
    }
    if (char === "]") {
      tokens.push({ type: "paren", value: "]" });
      index++;
      continue;
    }
    if (char === ":") {
      tokens.push({ type: "separator", value: ":" });
      index++;
      continue;
    }
    if (char === ",") {
      tokens.push({ type: "delimiter", value: "," });
      index++;
      continue;
    }
    if (char === '"') {
      let value = "";
      let incomplete = false;
      char = input[++index];
      while (char !== '"') {
        if (index === input.length) {
          incomplete = true;
          break;
        }
        if (char === "\\") {
          index++;
          if (index === input.length) {
            incomplete = true;
            break;
          }
          value += char + input[index];
          char = input[++index];
        } else {
          value += char;
          char = input[++index];
        }
      }
      char = input[++index];
      if (!incomplete) tokens.push({ type: "string", value });
      continue;
    }
    if (char && /\s/.test(char)) {
      index++;
      continue;
    }
    const digit = /[0-9]/;
    if ((char && digit.test(char)) || char === "-" || char === ".") {
      let value = "";
      if (char === "-") {
        value += char;
        char = input[++index];
      }
      while ((char && digit.test(char)) || char === ".") {
        value += char;
        char = input[++index];
      }
      tokens.push({ type: "number", value });
      continue;
    }
    const alpha = /[a-z]/i;
    if (char && alpha.test(char)) {
      let value = "";
      while (char && alpha.test(char)) {
        if (index === input.length) break;
        value += char;
        char = input[++index];
      }
      if (value === "true" || value === "false" || value === "null") {
        tokens.push({ type: "name", value });
      } else {
        index++;
      }
      continue;
    }
    index++;
  }
  return tokens;
}

function trimIncompleteJSONTokens(tokens: PartialJsonToken[]): PartialJsonToken[] {
  if (tokens.length === 0) return tokens;
  const last = tokens[tokens.length - 1]!;
  switch (last.type) {
    case "separator":
      return trimIncompleteJSONTokens(tokens.slice(0, tokens.length - 1));
    case "number": {
      const lastChar = last.value[last.value.length - 1];
      if (lastChar === "." || lastChar === "-") {
        return trimIncompleteJSONTokens(tokens.slice(0, tokens.length - 1));
      }
      break;
    }
    case "string": {
      const prev = tokens[tokens.length - 2];
      if (prev?.type === "delimiter") return trimIncompleteJSONTokens(tokens.slice(0, -1));
      if (prev?.type === "brace" && prev.value === "{") {
        return trimIncompleteJSONTokens(tokens.slice(0, -1));
      }
      break;
    }
    case "delimiter":
      return trimIncompleteJSONTokens(tokens.slice(0, tokens.length - 1));
  }
  return tokens;
}

function closePartialJSONTokens(tokens: PartialJsonToken[]): PartialJsonToken[] {
  const closers: Array<"}" | "]"> = [];
  tokens.forEach((token) => {
    if (token.type === "brace") {
      if (token.value === "{") closers.push("}");
      else closers.splice(closers.lastIndexOf("}"), 1);
    }
    if (token.type === "paren") {
      if (token.value === "[") closers.push("]");
      else closers.splice(closers.lastIndexOf("]"), 1);
    }
  });
  if (closers.length > 0) {
    closers.reverse().forEach((closer) => {
      if (closer === "}") tokens.push({ type: "brace", value: "}" });
      else if (closer === "]") tokens.push({ type: "paren", value: "]" });
    });
  }
  return tokens;
}

function stringifyPartialJSONTokens(tokens: PartialJsonToken[]): string {
  let output = "";
  tokens.forEach((token) => {
    switch (token.type) {
      case "string":
        output += '"' + token.value + '"';
        break;
      default:
        output += token.value;
        break;
    }
  });
  return output;
}

function parsePartialJSON(input: string): unknown {
  return JSON.parse(
    stringifyPartialJSONTokens(
      closePartialJSONTokens(trimIncompleteJSONTokens(tokenizePartialJSON(input))),
    ),
  );
}
