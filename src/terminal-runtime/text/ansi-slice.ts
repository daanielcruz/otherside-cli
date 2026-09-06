import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from "@alcalzone/ansi-tokenize";
import { paintCellWidth } from "@/terminal-runtime/text/cell-width.js";

function isTerminalCode(code: AnsiCode): boolean {
  return code.code === code.endCode;
}

function extractInitialCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter((c) => !isTerminalCode(c));
}

export default function truncateAnsiString(str: string, start: number, end?: number): string {
  const tokens = tokenize(str);
  let activeCodes: AnsiCode[] = [];
  let position = 0;
  let result = "";
  let include = false;

  for (const token of tokens) {
    const width = token.type === "char" ? paintCellWidth(token.value) : 0;

    if (end !== undefined && position >= end) {
      if (token.type === "ansi" || width > 0 || !include) break;
    }

    if (token.type === "ansi") {
      activeCodes.push(token);
      if (include) {
        result += token.code;
      }
    } else {
      if (!include && position >= start) {
        if (start > 0 && width === 0) continue;
        include = true;

        activeCodes = extractInitialCodes(reduceAnsiCodes(activeCodes));
        result = ansiCodesToString(activeCodes);
      }

      if (include && token.type === "char") {
        result += token.value;
      }

      position += width;
    }
  }

  const activeStartCodes = extractInitialCodes(reduceAnsiCodes(activeCodes));
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes));
  return result;
}
