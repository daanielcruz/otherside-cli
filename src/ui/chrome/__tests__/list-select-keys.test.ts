import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

const letter = (char: string, overrides: Partial<KeyEventData> = {}): KeyEventData =>
  key(char, { sequence: char, ...overrides });

const digit = (char: string): KeyEventData => key("number", { sequence: char });

describe("listSelectKey stepping", () => {
  it("steps with arrows, j/k and ctrl+n/ctrl+p", () => {
    const state = { cursor: 2, count: 5 };
    expect(listSelectKey(key("down"), state)).toEqual({ cursor: 3 });
    expect(listSelectKey(key("up"), state)).toEqual({ cursor: 1 });
    expect(listSelectKey(letter("j"), state)).toEqual({ cursor: 3 });
    expect(listSelectKey(letter("k"), state)).toEqual({ cursor: 1 });
    expect(listSelectKey(key("n", { ctrl: true }), state)).toEqual({ cursor: 3 });
    expect(listSelectKey(key("p", { ctrl: true }), state)).toEqual({ cursor: 1 });
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(listSelectKey(key("up"), { cursor: 0, count: 3 })).toEqual({ cursor: 0 });
    expect(listSelectKey(key("down"), { cursor: 2, count: 3 })).toEqual({ cursor: 2 });
  });

  it("moves by the caller's page and lands on the ends", () => {
    const state = { cursor: 10, count: 40, pageSize: 7 };
    expect(listSelectKey(key("pagedown"), state)).toEqual({ cursor: 17 });
    expect(listSelectKey(key("pageup"), state)).toEqual({ cursor: 3 });
    expect(listSelectKey(key("home"), state)).toEqual({ cursor: 0 });
    expect(listSelectKey(key("end"), state)).toEqual({ cursor: 39 });
  });

  it("pages by one row when the caller gives no page size", () => {
    expect(listSelectKey(key("pagedown"), { cursor: 0, count: 9 })).toEqual({ cursor: 1 });
  });
});

describe("listSelectKey digits", () => {
  it("jumps to the nth row and takes it", () => {
    expect(listSelectKey(digit("1"), { cursor: 4, count: 9 })).toEqual({
      cursor: 0,
      activate: true,
    });
    expect(listSelectKey(digit("9"), { cursor: 0, count: 9 })).toEqual({
      cursor: 8,
      activate: true,
    });
  });

  it("leaves digits past the last row and 0 to the panel", () => {
    expect(listSelectKey(digit("4"), { cursor: 0, count: 3 })).toBeUndefined();
    expect(listSelectKey(digit("0"), { cursor: 0, count: 9 })).toBeUndefined();
  });
});

describe("listSelectKey abstentions", () => {
  it("answers nothing for an empty list", () => {
    expect(listSelectKey(key("down"), { cursor: 0, count: 0 })).toBeUndefined();
    expect(listSelectKey(digit("1"), { cursor: 0, count: 0 })).toBeUndefined();
  });

  it("leaves the panel's own keys alone", () => {
    const state = { cursor: 1, count: 5 };
    expect(listSelectKey(key("return"), state)).toBeUndefined();
    expect(listSelectKey(key("escape"), state)).toBeUndefined();
    expect(listSelectKey(key("left"), state)).toBeUndefined();
    expect(listSelectKey(key("right"), state)).toBeUndefined();
    expect(listSelectKey(letter("x"), state)).toBeUndefined();
    expect(listSelectKey(letter("t"), state)).toBeUndefined();
  });

  it("ignores modified letters so chords stay with their owners", () => {
    const state = { cursor: 1, count: 5 };
    expect(listSelectKey(letter("j", { meta: true }), state)).toBeUndefined();
    expect(listSelectKey(key("k", { ctrl: true }), state)).toBeUndefined();
    expect(listSelectKey(letter("J", { shift: true }), state)).toBeUndefined();
    expect(listSelectKey(key("n", { ctrl: true, meta: true }), state)).toBeUndefined();
  });
});
