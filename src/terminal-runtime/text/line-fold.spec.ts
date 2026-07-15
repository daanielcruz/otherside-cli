import { describe, expect, it } from "bun:test";
import wrapText, { elideWrapBoundarySpace } from "@/terminal-runtime/text/line-fold.js";

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("wrapText conservation", () => {
  it("conserves every byte of the original text across wrap boundaries", () => {
    const text =
      "The glue fix belongs in the committer because the boundary is only visible there, and by removing the fixed width we";
    const wrapped = wrapText(text, 58, "wrap");
    expect(wrapped.replaceAll("\n", "")).toBe(text);
  });

  it("parks the boundary space at the continuation start on exact-fill lines", () => {
    const text = "The glue fix belongs in the committer because the boundary is only visible there";
    const lines = wrapText(text, 58, "wrap").split("\n");
    expect(lines[0]).toBe("The glue fix belongs in the committer because the boundary");
    expect(lines[1]).toBe(" is only visible there");
  });

  it("keeps a trailing separator on the previous line when it fits", () => {
    const lines = wrapText("one two three four5 six seven", 20, "wrap").split("\n");
    expect(lines[0]).toBe("one two three four5 ");
    expect(lines[1]).toBe("six seven");
  });

  it("preserves authored leading indentation on hard newlines", () => {
    const text = "header line\n    indented code stays put";
    const lines = wrapText(text, 40, "wrap").split("\n");
    expect(lines[1]).toBe("    indented code stays put");
  });

  it("wrap-trim behavior is unchanged", () => {
    expect(wrapText("  padded  ", 20, "wrap-trim")).toBe("padded");
  });
});

describe("elideWrapBoundarySpace", () => {
  it("drops exactly one leading space and reports the elision", () => {
    const result = elideWrapBoundarySpace(" is only visible there");
    expect(result.line).toBe("is only visible there");
    expect(result.elided).toBe(true);
  });

  it("leaves lines without a boundary space untouched", () => {
    const result = elideWrapBoundarySpace("six seven");
    expect(result.line).toBe("six seven");
    expect(result.elided).toBe(false);
  });

  it("drops the boundary space behind a re-opened SGR style", () => {
    const dim = "\u001b[2m";
    const result = elideWrapBoundarySpace(`${dim} uses a Session obj`);
    expect(result.elided).toBe(true);
    expect(stripAnsi(result.line)).toBe("uses a Session obj");
    expect(result.line.startsWith(dim)).toBe(true);
  });

  it("never empties a space-only continuation line", () => {
    const result = elideWrapBoundarySpace(" ");
    expect(result.line).toBe(" ");
    expect(result.elided).toBe(false);
  });

  it("drops only ONE space when the continuation starts with several", () => {
    const result = elideWrapBoundarySpace("  double");
    expect(result.line).toBe(" double");
    expect(result.elided).toBe(true);
  });
});

describe('wrapText "wrap-stream"', () => {
  it('wraps byte-identically to "wrap" (the trailing-piece drop is the renderer\'s)', () => {
    const text = "The glue fix belongs in the committer because the boundary is only visible there";
    expect(wrapText(text, 58, "wrap-stream")).toBe(wrapText(text, 58, "wrap"));
  });

  it("keeps a fitting line whole (measurement must reserve its row)", () => {
    expect(wrapText("partial las", 60, "wrap-stream")).toBe("partial las");
  });
});
