import { createTokenizer } from "@/terminal-runtime/terminal/sequence-tokens.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

const DEFAULT_TAB_INTERVAL = 8;

export function expandTabs(text: string, interval = DEFAULT_TAB_INTERVAL): string {
  if (!text.includes("\t")) {
    return text;
  }

  const tokenizer = createTokenizer();
  const tokens = tokenizer.feed(text);
  tokens.push(...tokenizer.flush());

  let result = "";
  let column = 0;

  for (const token of tokens) {
    if (token.type === "sequence") {
      result += token.value;
    } else {
      const parts = token.value.split(/(\t|\n)/);
      for (const part of parts) {
        if (part === "\t") {
          const spaces = interval - (column % interval);
          result += " ".repeat(spaces);
          column += spaces;
        } else if (part === "\n") {
          result += part;
          column = 0;
        } else {
          result += part;
          column += stringWidth(part);
        }
      }
    }
  }

  return result;
}
