import { describe, expect, it } from "bun:test";
import { parseSedEditCommand } from "../sed-edit.ts";

describe("parseSedEditCommand", () => {
  it("should parse normal single-expression sed edits", () => {
    expect(parseSedEditCommand("sed -i s/a/b/ file.txt")).toEqual({
      filePath: "file.txt",
      pattern: "a",
      replacement: "b",
      flags: "",
      extendedRegex: false,
    });

    expect(parseSedEditCommand("sed -i -e s/a/b/ file.txt")).toEqual({
      filePath: "file.txt",
      pattern: "a",
      replacement: "b",
      flags: "",
      extendedRegex: false,
    });
  });

  it("should return null for multiple expressions or mixed positional and expression flags", () => {
    // Two expression flags
    expect(parseSedEditCommand("sed -i -e s/a/b/ -e s/c/d/ file.txt")).toBeNull();

    // Positional expression first, then expression flag (the bug)
    expect(parseSedEditCommand("sed -i s/a/b/ file.txt -e s/c/d/")).toBeNull();
    expect(parseSedEditCommand("sed -i s/a/b/ -e s/c/d/ file.txt")).toBeNull();

    // Long expression flag mix
    expect(parseSedEditCommand("sed -i s/a/b/ file.txt --expression=s/c/d/")).toBeNull();
    expect(parseSedEditCommand("sed -i --expression=s/c/d/ s/a/b/ file.txt")).toBeNull();
  });
});
