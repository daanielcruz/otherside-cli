import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { type PanelSearchState, searchKeyTransition } from "@/ui/chrome/panel-search.ts";

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

const idle = (query = ""): PanelSearchState => ({ focused: false, query });
const active = (query = ""): PanelSearchState => ({ focused: true, query });

describe("searchKeyTransition entry", () => {
  it("enters on slash under both policies without seeding", () => {
    for (const policy of ["slash-and-typing-seeds", "slash-only"] as const) {
      expect(
        searchKeyTransition({ state: idle("kept"), key: key("/", { sequence: "/" }), policy }),
      ).toEqual({ state: { focused: true, query: "kept" } });
    }
  });

  it("enters seeding the query on a printable char when the policy allows typing", () => {
    const result = searchKeyTransition({
      state: idle(),
      key: key("a", { sequence: "a" }),
      policy: "slash-and-typing-seeds",
    });
    expect(result).toEqual({ state: { focused: true, query: "a" } });
  });

  it("ignores printable chars and up-entry under slash-only", () => {
    const slashOnly = { state: idle(), policy: "slash-only" as const };
    expect(searchKeyTransition({ ...slashOnly, key: key("a", { sequence: "a" }) })).toBeUndefined();
    expect(searchKeyTransition({ ...slashOnly, key: key("up"), atListTop: true })).toBeUndefined();
  });

  it("enters on up only from the first list item", () => {
    const seeds = { state: idle(), policy: "slash-and-typing-seeds" as const };
    expect(searchKeyTransition({ ...seeds, key: key("up"), atListTop: true })).toEqual({
      state: { focused: true, query: "" },
    });
    expect(searchKeyTransition({ ...seeds, key: key("up"), atListTop: false })).toBeUndefined();
  });

  it("ignores modified keys and non-printable sequences", () => {
    const seeds = { state: idle(), policy: "slash-and-typing-seeds" as const };
    expect(
      searchKeyTransition({ ...seeds, key: key("a", { sequence: "a", ctrl: true }) }),
    ).toBeUndefined();
    expect(searchKeyTransition({ ...seeds, key: key("down") })).toBeUndefined();
  });
});

describe("searchKeyTransition while focused", () => {
  const focusedInput = { policy: "slash-and-typing-seeds" as const, hasHeader: true };

  it("appends printable chars and trims on backspace", () => {
    expect(
      searchKeyTransition({
        ...focusedInput,
        state: active("a"),
        key: key("b", { sequence: "b" }),
      }),
    ).toEqual({ state: { focused: true, query: "ab", cursorOffset: 2 } });
    expect(
      searchKeyTransition({ ...focusedInput, state: active("ab"), key: key("backspace") }),
    ).toEqual({ state: { focused: true, query: "a", cursorOffset: 1 } });
  });

  it("walks the Esc ladder: first clears the query, second exits", () => {
    const cleared = searchKeyTransition({
      ...focusedInput,
      state: active("abc"),
      key: key("escape"),
    });
    expect(cleared).toEqual({ state: { focused: true, query: "" } });

    const exited = searchKeyTransition({
      ...focusedInput,
      state: cleared!.state,
      key: key("escape"),
    });
    expect(exited).toEqual({ state: { focused: false, query: "" }, exitTo: "list" });
  });

  it("exits to the list on enter, down, and backspace on empty", () => {
    for (const exitKey of [key("return"), key("down")]) {
      expect(searchKeyTransition({ ...focusedInput, state: active("abc"), key: exitKey })).toEqual({
        state: { focused: false, query: "abc" },
        exitTo: "list",
      });
    }
    expect(
      searchKeyTransition({ ...focusedInput, state: active(""), key: key("backspace") }),
    ).toEqual({ state: { focused: false, query: "" }, exitTo: "list" });
  });

  it("exits to the header on up only when a header exists", () => {
    expect(searchKeyTransition({ ...focusedInput, state: active("q"), key: key("up") })).toEqual({
      state: { focused: false, query: "q" },
      exitTo: "header",
    });
    expect(
      searchKeyTransition({
        policy: "slash-and-typing-seeds",
        hasHeader: false,
        state: active("q"),
        key: key("up"),
      }),
    ).toEqual({ state: { focused: true, query: "q" } });
  });
});
