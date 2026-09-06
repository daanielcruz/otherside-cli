import type { Key } from "@/terminal-runtime";

const DIGITS_RE = /^[0-9]$/;
export const digitFilter = (ch: string): boolean => DIGITS_RE.test(ch);

function filterChunk(chunk: string, filter?: (ch: string) => boolean): string {
  if (!filter) return chunk;
  let out = "";
  for (const ch of chunk) if (filter(ch)) out += ch;
  return out;
}

export function applyTextFieldKey(
  value: string,
  input: string,
  key: Key,
  opts: { filter?: ((ch: string) => boolean) | undefined; multiline?: boolean | undefined } = {},
): { consumed: boolean; next: string } {
  const { filter, multiline } = opts;
  if (key.backspace || key.delete) {
    return { consumed: true, next: value.length === 0 ? value : value.slice(0, -1) };
  }
  if (!input) return { consumed: false, next: value };
  if (key.ctrl || key.meta) return { consumed: false, next: value };
  if (key.return && !multiline) return { consumed: false, next: value };
  const accepted = filterChunk(input, filter);
  if (accepted.length === 0) return { consumed: true, next: value };
  return { consumed: true, next: value + accepted };
}
