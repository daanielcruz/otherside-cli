import { describe, expect, it } from "bun:test";
import stripAnsi from "strip-ansi";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.tsx";
import { renderPayload } from "@/ui/transcript/tool-render/payload-view.tsx";

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("renderDiffAnsiLines", () => {
  it("wraps context rows without splitting an emoji at the column boundary", () => {
    const rendered = renderDiffAnsiLines(
      ["--- a/demo.txt", "+++ b/demo.txt", "@@ -1,2 +1,2 @@", " abc😀z", "-old", "+new"].join("\n"),
      8,
      "demo.txt",
    );

    expect(rendered).not.toBeNull();
    const bodyLines = rendered?.bodyLines ?? [];
    expect(bodyLines.some(hasUnpairedSurrogate)).toBe(false);
    expect(bodyLines.map(stripAnsi)).toContain("    😀z ");
  });

  it("keeps ASCII context wrapping unchanged", () => {
    const rendered = renderDiffAnsiLines(
      ["--- a/demo.txt", "+++ b/demo.txt", "@@ -1,2 +1,2 @@", " abcdef", "-old", "+new"].join("\n"),
      8,
      "demo.txt",
    );

    expect(rendered).not.toBeNull();
    expect((rendered?.bodyLines ?? []).map(stripAnsi).slice(0, 2)).toEqual([
      "1   abcd",
      "    ef  ",
    ]);
  });

  it("clips the multi-hunk separator to a narrow column budget", () => {
    const twoHunks = [
      "--- a/d.ts",
      "+++ b/d.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -5,1 +5,1 @@",
      "-c",
      "+d",
    ].join("\n");
    for (const width of [1, 2]) {
      const rendered = renderDiffAnsiLines(twoHunks, width, "d.ts");
      expect(rendered).not.toBeNull();
      const rows = (rendered?.bodyLines ?? []).map(stripAnsi);
      // The inter-hunk separator is the dots-only row; it must fit the budget
      // rather than the fixed 3-wide "..." that padEnd never shortens.
      const separators = rows.filter((row) => /^\.+$/.test(row));
      expect(separators.length).toBeGreaterThan(0);
      for (const sep of separators) {
        expect(Bun.stringWidth(sep)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("wraps long changed rows without clipping their text", () => {
    const removed = "abcdefghijklmnopqrstuvwxyz0123456789";
    const added = "ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210";
    const rendered = renderDiffAnsiLines(
      ["--- a/demo.ts", "+++ b/demo.ts", "@@ -1 +1 @@", `-${removed}`, `+${added}`].join("\n"),
      16,
      "demo.ts",
    );

    expect(rendered).not.toBeNull();
    const rows = (rendered?.bodyLines ?? []).map(stripAnsi);
    expect(rows.every((row) => Bun.stringWidth(row) === 16)).toBe(true);
    expect(
      rows
        .filter((row) => row[2] === "-")
        .map((row) => row.slice(4).trimEnd())
        .join(""),
    ).toBe(removed);
    expect(
      rows
        .filter((row) => row[2] === "+")
        .map((row) => row.slice(4).trimEnd())
        .join(""),
    ).toBe(added);
  });

  it("composes gutter and changed rows to the full terminal width", () => {
    const fragment = [
      "--- a/demo.ts",
      "+++ b/demo.ts",
      "@@ -1 +1 @@",
      "-abcdefghijklmnopqrstuvwxyz0123456789",
      "+ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210",
    ].join("\n");

    for (const width of [20, 40, 80]) {
      const elements = renderPayload({ kind: "diff", fragment, filePath: "demo.ts" }, false, width);
      const body = elements.find((element) => element.key === "diff-body") as
        | { props: { lines: string[]; width: number } }
        | undefined;
      expect(body).toBeDefined();
      expect(body?.props.width).toBe(width);
      expect(
        (body?.props.lines ?? []).every((row) => Bun.stringWidth(stripAnsi(row)) === width),
      ).toBe(true);
    }
  });

  it("compacts prefixes before a wide grapheme can overflow a narrow row", () => {
    const rendered = renderDiffAnsiLines(
      ["--- a/demo.txt", "+++ b/demo.txt", "@@ -1 +1 @@", "-😀x", "+😀y"].join("\n"),
      5,
      "demo.txt",
    );

    expect(rendered).not.toBeNull();
    const rows = rendered?.bodyLines ?? [];
    expect(rows.some(hasUnpairedSurrogate)).toBe(false);
    expect(rows.every((row) => Bun.stringWidth(stripAnsi(row)) <= 5)).toBe(true);
  });

  it("keeps multi-hunk separators inside the diff width", () => {
    const rendered = renderDiffAnsiLines(
      [
        "--- a/demo.ts",
        "+++ b/demo.ts",
        "@@ -1 +1 @@",
        "-one",
        "+ONE",
        "@@ -5 +5 @@",
        "-two",
        "+TWO",
      ].join("\n"),
      16,
      "demo.ts",
    );

    expect(rendered).not.toBeNull();
    const separator = (rendered?.bodyLines ?? [])
      .map(stripAnsi)
      .find((row) => row.startsWith("..."));
    expect(separator).toBeDefined();
    expect(Bun.stringWidth(separator ?? "")).toBe(16);
  });
});
