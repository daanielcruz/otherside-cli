import { describe, expect, it } from "bun:test";
import { applyEdit } from "@/design/capabilities/canvas-tools.ts";

const PATH = "design.os.html";

describe("applyEdit — update_design find/replace semantics", () => {
  it("returns the full content when content is provided", () => {
    const result = applyEdit("<p>old</p>", PATH, { content: "<p>new</p>" });
    expect(result).toEqual({ content: "<p>new</p>" });
  });

  it("content wins even when find is also present", () => {
    const result = applyEdit("<p>old</p>", PATH, {
      content: "<p>new</p>",
      find: "old",
      replace: "x",
    });
    expect(result).toEqual({ content: "<p>new</p>" });
  });

  it("replaces a unique single match", () => {
    const result = applyEdit("<span>uniqueZ</span>", PATH, {
      find: "uniqueZ",
      replace: "done",
    });
    expect(result).toEqual({ content: "<span>done</span>" });
  });

  it("errors when the find string is absent", () => {
    const result = applyEdit("<p>hi</p>", PATH, { find: "missing", replace: "x" });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("not found");
  });

  it("errors when the find string matches more than once", () => {
    const result = applyEdit("<i>A</i><i>A</i>", PATH, { find: "A", replace: "x" });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("matches 2 times");
  });

  it("errors on an empty find string", () => {
    const result = applyEdit("<p>hi</p>", PATH, { find: "", replace: "x" });
    expect(result).toBe("find must be a non-empty string");
  });

  it("treats the replacement literally — no $ substitution", () => {
    const result = applyEdit("<span>uniqueZ</span>", PATH, {
      find: "uniqueZ",
      replace: "$& $1 $` DONE",
    });
    expect(result).toEqual({ content: "<span>$& $1 $` DONE</span>" });
  });
});
