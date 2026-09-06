import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { isInsertable, keyInput, printableText, typedText } from "../key-input.ts";

const key = (partial: Partial<KeyEventData>): KeyEventData => partial as KeyEventData;

describe("isInsertable", () => {
  it("accepts printable text and rejects controls", () => {
    expect(isInsertable("a")).toBe(true);
    expect(isInsertable("é")).toBe(true);
    expect(isInsertable("")).toBe(false);
    expect(isInsertable("\x1b[D")).toBe(false);
    expect(isInsertable("\x7f")).toBe(false);
    expect(isInsertable("\x03")).toBe(false);
  });
});

describe("keyInput", () => {
  it("passes printable text through", () => {
    expect(keyInput(key({ sequence: "a" }))).toBe("a");
    expect(keyInput(key({ sequence: "/" }))).toBe("/");
  });

  it("maps the space name to a literal space", () => {
    expect(keyInput(key({ name: "space", sequence: " " }))).toBe(" ");
  });

  it("contributes nothing for escape-led and control sequences", () => {
    expect(keyInput(key({ name: "up", sequence: "\x1b[A" }))).toBe("");
    expect(keyInput(key({ name: "left", sequence: "\x1b[D" }))).toBe("");
    expect(keyInput(key({ name: "right", sequence: "\x1b[C" }))).toBe("");
    expect(keyInput(key({ name: "escape", sequence: "\x1b" }))).toBe("");
    expect(keyInput(key({ name: "backspace", sequence: "\x7f" }))).toBe("");
  });

  it("names the chord under modifiers", () => {
    expect(keyInput(key({ ctrl: true, name: "r", sequence: "\x12" }))).toBe("r");
    expect(keyInput(key({ meta: true, name: "b", sequence: "\x1bb" }))).toBe("b");
  });
});

describe("typedText", () => {
  it("gives the text a key types", () => {
    expect(typedText(key({ name: "a", sequence: "a" }))).toBe("a");
    expect(typedText(key({ name: "space", sequence: " " }))).toBe(" ");
  });

  it("gives nothing for a key carrying a gesture", () => {
    // keyInput reports a modified key by NAME, which would otherwise read as
    // someone typing that name.
    expect(typedText(key({ ctrl: true, name: "e", sequence: "\x05" }))).toBe("");
    expect(typedText(key({ meta: true, name: "b", sequence: "\x1bb" }))).toBe("");
    expect(typedText(key({ name: "escape", sequence: "\x1b" }))).toBe("");
    expect(typedText(key({ name: "left", sequence: "\x1b[D" }))).toBe("");
  });
});

describe("printableText", () => {
  it("keeps the text of a run and drops the rest", () => {
    expect(printableText("abc")).toBe("abc");
    expect(printableText("a\x01b\x7fc")).toBe("abc");
    expect(printableText("")).toBe("");
  });

  it("drops an escape, which is never typed text", () => {
    // The resume rename field used to keep it, which put a raw escape byte in a
    // stored title. One predicate for both surfaces closes that.
    expect(printableText("a\x1bb")).toBe("ab");
  });

  it("agrees with isInsertable on a single character", () => {
    for (const character of ["a", "é", " ", "\x1b", "\x7f", "\x01"]) {
      expect(printableText(character).length > 0).toBe(isInsertable(character));
    }
  });
});
