import { useCallback, useMemo } from "react";
import type { Key } from "@/ink";

export interface UseTextFieldOptions {
  value: string;
  onChange: (next: string) => void;
  filter?: ((char: string) => boolean) | undefined;
  multiline?: boolean | undefined;
}

export interface UseTextFieldApi {
  handleKey: (input: string, key: Key) => boolean;
  append: (chunk: string) => void;
  backspace: () => void;
}

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

export function useTextField(opts: UseTextFieldOptions): UseTextFieldApi {
  const { value, onChange, filter, multiline } = opts;

  const append = useCallback(
    (chunk: string): void => {
      const accepted = filterChunk(chunk, filter);
      if (accepted.length === 0) return;
      onChange(value + accepted);
    },
    [value, onChange, filter],
  );

  const backspace = useCallback((): void => {
    if (value.length === 0) return;
    onChange(value.slice(0, -1));
  }, [value, onChange]);

  const handleKey = useCallback(
    (input: string, key: Key): boolean => {
      const { consumed, next } = applyTextFieldKey(value, input, key, { filter, multiline });
      if (!consumed) return false;
      if (next !== value) onChange(next);
      return true;
    },
    [value, onChange, filter, multiline],
  );

  return useMemo(() => ({ handleKey, append, backspace }), [handleKey, append, backspace]);
}
