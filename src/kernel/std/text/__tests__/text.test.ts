import { describe, expect, it } from "bun:test";
import { capUtf8ToBytes } from "../text.ts";

describe("capUtf8ToBytes", () => {
  it("returns the string unchanged when within the byte cap", () => {
    expect(capUtf8ToBytes("hello", 64)).toBe("hello");
  });

  it("returns the string unchanged when exactly at the byte cap", () => {
    expect(capUtf8ToBytes("hello", 5)).toBe("hello");
  });

  it("truncates oversized ASCII content to exactly the byte cap", () => {
    const result = capUtf8ToBytes("a".repeat(100), 10);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(10);
  });

  it("caps by bytes, not characters, for multibyte content", () => {
    const fourBytes = "𝄞"; // U+1D11E — 4 UTF-8 bytes
    const result = capUtf8ToBytes(fourBytes.repeat(10), 10);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(10);
  });
});
