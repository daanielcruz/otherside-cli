import { describe, expect, test } from "bun:test";
import type { Key } from "@/ink";
import { applyTextFieldKey, digitFilter } from "@/ui/hooks/use-text-field.ts";

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as Key;
}

// Drive the pure key-handling helper used inside useTextField. The hook itself
// is a memoized wrapper over this function plus onChange, so the logic is
// exercised here without needing a React renderer.
function drive(
  initial: string,
  filter?: ((ch: string) => boolean) | undefined,
  multiline?: boolean | undefined,
) {
  let value = initial;
  return {
    fire: (input: string, key: Key): boolean => {
      const { consumed, next } = applyTextFieldKey(value, input, key, { filter, multiline });
      if (consumed) value = next;
      return consumed;
    },
    get value() {
      return value;
    },
  };
}

describe("useTextField", () => {
  test("appends a printable character", () => {
    const f = drive("abc");
    expect(f.fire("d", makeKey())).toBe(true);
    expect(f.value).toBe("abcd");
  });

  test("appends a multi-char paste chunk", () => {
    const f = drive("");
    expect(f.fire("sk-paste-1234", makeKey())).toBe(true);
    expect(f.value).toBe("sk-paste-1234");
  });

  test("backspace pops last char", () => {
    const f = drive("abc");
    expect(f.fire("", makeKey({ backspace: true }))).toBe(true);
    expect(f.value).toBe("ab");
  });

  test("delete key also pops last char", () => {
    const f = drive("hello");
    expect(f.fire("", makeKey({ delete: true }))).toBe(true);
    expect(f.value).toBe("hell");
  });

  test("backspace on empty value is a no-op", () => {
    const f = drive("");
    expect(f.fire("", makeKey({ backspace: true }))).toBe(true);
    expect(f.value).toBe("");
  });

  test("ctrl and meta modified keys are ignored", () => {
    const f = drive("x");
    expect(f.fire("c", makeKey({ ctrl: true }))).toBe(false);
    expect(f.fire("v", makeKey({ meta: true }))).toBe(false);
    expect(f.value).toBe("x");
  });

  test("digit filter accepts digits, rejects letters (keystroke)", () => {
    const f = drive("12", digitFilter);
    expect(f.fire("3", makeKey())).toBe(true);
    expect(f.value).toBe("123");
    expect(f.fire("a", makeKey())).toBe(true); // handled, but filtered to empty
    expect(f.value).toBe("123");
  });

  test("digit filter strips non-digits from a pasted chunk", () => {
    const f = drive("", digitFilter);
    expect(f.fire("200_000", makeKey())).toBe(true);
    expect(f.value).toBe("200000");
  });

  test("return is not appended unless multiline=true", () => {
    const f1 = drive("abc");
    expect(f1.fire("\r", makeKey({ return: true }))).toBe(false);
    expect(f1.value).toBe("abc");
    const f2 = drive("abc", undefined, true);
    expect(f2.fire("\n", makeKey({ return: true }))).toBe(true);
    expect(f2.value).toBe("abc\n");
  });
});
