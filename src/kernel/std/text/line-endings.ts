import { isWindows } from "../proc/platform.ts";

export type LineEndingType = "CRLF" | "LF";

export function detectLineEndings(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") crlfCount += 1;
      else lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export function applyLineEndings(content: string, endings: LineEndingType): string {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (endings === "LF") return normalized;
  return normalized.split("\n").join("\r\n");
}

export function defaultLineEndings(): LineEndingType {
  return isWindows() ? "CRLF" : "LF";
}
