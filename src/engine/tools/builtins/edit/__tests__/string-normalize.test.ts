import { describe, expect, it } from "bun:test";
import { normalizeEditStrings } from "@/engine/tools/builtins/edit/string-normalize.ts";

describe("normalizeEditStrings — trailing whitespace", () => {
  it("keeps a deliberate trailing-whitespace-only edit instead of collapsing to a no-op", () => {
    const { newString } = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "foo",
      oldString: "foo",
      newString: "foo   ",
    });
    expect(newString).toBe("foo   ");
  });

  it("still strips accidental trailing whitespace on a real content change", () => {
    const { newString } = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "foo",
      oldString: "foo",
      newString: "bar   ",
    });
    expect(newString).toBe("bar");
  });
});

describe("normalizeEditStrings — desanitization", () => {
  it("desanitizes markers present only in new_string, not just the old_string ones", () => {
    const { oldString, newString } = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "<name>x</name>",
      oldString: "<n>x</n>",
      newString: "<o>y</o>",
    });
    expect(oldString).toBe("<name>x</name>");
    expect(newString).toBe("<output>y</output>");
  });
});
