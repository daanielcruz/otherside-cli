import { describe, expect, test } from "bun:test";
import { tokenize } from "@/ui/transcript/markdown/highlight.ts";

describe("tokenize cache", () => {
  test("repeated calls return the cached span array", () => {
    const code = "const answer = 42;";
    const first = tokenize(code, "typescript");
    const second = tokenize(code, "typescript");
    expect(second).toBe(first);
  });

  test("different languages for the same code cache independently", () => {
    const code = "value = 1";
    const asPython = tokenize(code, "python");
    const asRuby = tokenize(code, "ruby");
    expect(asPython).not.toBe(asRuby);
    expect(tokenize(code, "python")).toBe(asPython);
  });

  test("unknown language bypasses the cache", () => {
    const code = "plain text";
    const first = tokenize(code, "not-a-language");
    const second = tokenize(code, "not-a-language");
    expect(first).toEqual([{ text: code }]);
    expect(second).not.toBe(first);
  });

  test("the cache evicts the least recently used entry past the cap", () => {
    const pinned = "let pinned = 'keep me';";
    const evicted = "let evicted = 'drop me';";
    const firstPinned = tokenize(pinned, "javascript");
    const firstEvicted = tokenize(evicted, "javascript");
    for (let i = 0; i < 550; i += 1) {
      tokenize(`let filler${i} = ${i};`, "javascript");
      // Touch the pinned entry so eviction takes the untouched one, never it.
      tokenize(pinned, "javascript");
    }
    expect(tokenize(pinned, "javascript")).toBe(firstPinned);
    expect(tokenize(evicted, "javascript")).not.toBe(firstEvicted);
  });
});
