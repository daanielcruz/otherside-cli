const QUOTED_PATTERN = /^(?:"(?:[^"\\]|\\.)*"|'[^']*')$/;

export function tokenizeSegment(segment: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (quote) {
      if (quote === '"' && ch === "\\") {
        buf += ch + (segment[i + 1] ?? "");
        i++;
        continue;
      }
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      buf += ch + (segment[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

export function isQuoted(token: string): boolean {
  return QUOTED_PATTERN.test(token);
}

export function unquote(token: string): string {
  if (QUOTED_PATTERN.test(token)) return token.slice(1, -1);
  return token;
}
