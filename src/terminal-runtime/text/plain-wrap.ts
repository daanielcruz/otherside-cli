import { stringWidth as cellWidth } from "@/terminal-runtime/text/cell-width.js";

export { cellWidth };

export interface WrapOptions {
  width: number;
}

export function wrapLine(line: string, opts: WrapOptions): string[] {
  const width = Math.max(1, opts.width);
  if (cellWidth(line) <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of splitInclusive(line, " ")) {
    if (cellWidth(current) + cellWidth(word) > width && current.length > 0) {
      out.push(current);
      current = "";
    }
    if (cellWidth(word) > width) {
      for (const ch of [...word]) {
        if (cellWidth(current) + cellWidth(ch) > width && current.length > 0) {
          out.push(current);
          current = "";
        }
        current += ch;
      }
    } else {
      current += word;
    }
  }
  if (current.length > 0) out.push(current);
  if (out.length === 0) out.push(line);
  return out;
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    out.push(...wrapLine(raw, { width }));
  }
  return out;
}

export function lineContainsUrlLike(line: string): boolean {
  return line.split(/\s+/).some(isUrlLike);
}

export function lineHasMixedUrlAndNonUrlTokens(line: string): boolean {
  let sawUrl = false;
  let sawOther = false;
  for (const tok of line.split(/\s+/)) {
    if (tok.length === 0) continue;
    if (isUrlLike(tok)) sawUrl = true;
    else sawOther = true;
    if (sawUrl && sawOther) return true;
  }
  return false;
}

function isUrlLike(tok: string): boolean {
  const lower = tok.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ftp://") ||
    lower.startsWith("file://") ||
    lower.startsWith("www.")
  );
}

function splitInclusive(text: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (ch === sep) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
