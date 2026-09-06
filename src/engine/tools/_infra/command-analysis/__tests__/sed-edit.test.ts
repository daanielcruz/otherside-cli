import { describe, expect, it } from "bun:test";
import { parseSedEditInvocation } from "../sed-edit.ts";

describe("parseSedEditInvocation", () => {
  it("should parse normal single-expression sed edits", () => {
    expect(parseSedEditInvocation("sed -i s/a/b/ file.txt")).toEqual({
      filePath: "file.txt",
      pattern: "a",
      replacement: "b",
      flags: "",
      extendedRegex: false,
    });

    expect(parseSedEditInvocation("sed -i -e s/a/b/ file.txt")).toEqual({
      filePath: "file.txt",
      pattern: "a",
      replacement: "b",
      flags: "",
      extendedRegex: false,
    });
  });

  it("should return null for multiple expressions or mixed positional and expression flags", () => {
    // Two expression flags
    expect(parseSedEditInvocation("sed -i -e s/a/b/ -e s/c/d/ file.txt")).toBeNull();

    // Positional expression first, then expression flag (the bug)
    expect(parseSedEditInvocation("sed -i s/a/b/ file.txt -e s/c/d/")).toBeNull();
    expect(parseSedEditInvocation("sed -i s/a/b/ -e s/c/d/ file.txt")).toBeNull();

    // Long expression flag mix
    expect(parseSedEditInvocation("sed -i s/a/b/ file.txt --expression=s/c/d/")).toBeNull();
    expect(parseSedEditInvocation("sed -i --expression=s/c/d/ s/a/b/ file.txt")).toBeNull();
  });
});
