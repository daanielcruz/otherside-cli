import { describe, expect, it } from "bun:test";
import { applyLineEndings } from "../line-endings.ts";

describe("applyLineEndings", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(applyLineEndings("alpha\r\nbeta\rgamma\n", "LF")).toBe("alpha\nbeta\ngamma\n");
  });

  it("normalizes mixed input to CRLF without adding carriage returns", () => {
    expect(applyLineEndings("alpha\r\nbeta\rgamma\n", "CRLF")).toBe("alpha\r\nbeta\r\ngamma\r\n");
  });

  it("is idempotent for CRLF output", () => {
    const normalized = applyLineEndings("alpha\r\nbeta\rgamma\n", "CRLF");

    expect(applyLineEndings(normalized, "CRLF")).toBe(normalized);
    expect(normalized).not.toContain("\r\r\n");
  });

  it("preserves real tabs separately from literal backslash-t text", () => {
    expect(applyLineEndings("real\ttab\r\nliteral\\ttext\r", "LF")).toBe(
      "real\ttab\nliteral\\ttext\n",
    );
  });
});
