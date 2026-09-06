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

  it("preserves each newline form while stripping only preceding horizontal whitespace", () => {
    const { newString } = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "before",
      oldString: "before",
      newString: "one  \r\ntwo\t\rthree   \nfour\t",
    });
    expect(newString).toBe("one\r\ntwo\rthree\nfour");
  });

  it("preserves trailing whitespace in markdown", () => {
    const { newString } = normalizeEditStrings({
      filePath: "notes.mdx",
      fileContent: "before",
      oldString: "before",
      newString: "after  \n",
    });
    expect(newString).toBe("after  \n");
  });
});

describe("normalizeEditStrings — typography", () => {
  it("matches straight requested quotes against typographic file content", () => {
    const result = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "const label = “hello”",
      oldString: 'const label = "hello"',
      newString: 'const label = "world"',
    });
    expect(result).toEqual({
      oldString: "const label = “hello”",
      newString: "const label = “world”",
    });
  });

  it("distinguishes opening single quotes from contractions", () => {
    const result = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "It’s called ‘fine’",
      oldString: "It's called 'fine'",
      newString: "It's called 'better'",
    });
    expect(result).toEqual({
      oldString: "It’s called ‘fine’",
      newString: "It’s called ‘better’",
    });
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

  it("restores metadata and conversation markers in table order", () => {
    const result = normalizeEditStrings({
      filePath: "a.ts",
      fileContent: "<META_START><EOT><META_END>\n\nHuman: hi\n\nAssistant: hello",
      oldString: "< META_START >< EOT >< META_END >\n\nH: hi\n\nA: hello",
      newString: "< SOS >< META >\n\nA: changed",
    });
    expect(result).toEqual({
      oldString: "<META_START><EOT><META_END>\n\nHuman: hi\n\nAssistant: hello",
      newString: "<SOS><META>\n\nAssistant: changed",
    });
  });
});
