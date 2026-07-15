import { describe, expect, test } from "bun:test";
import { deriveForkName, forkDescriptionFromDirective } from "../derive-name.ts";

describe("deriveForkName", () => {
  test("uses first three tokens, lowercased and hyphenated", () => {
    expect(deriveForkName("Review the auth flow carefully")).toBe("review-the-auth");
  });

  test("strips non-alnum and collapses hyphens", () => {
    // Tokenize first (whitespace), then clean — "/" is its own token and vanishes.
    expect(deriveForkName("Fix!!! API / tokens")).toBe("fix-api");
    expect(deriveForkName("Fix!!! API tokens")).toBe("fix-api-tokens");
  });

  test("caps at 24 characters", () => {
    const name = deriveForkName("abcdefghijklm nopqrstuvwxyz 1234567890");
    expect(name.length).toBeLessThanOrEqual(24);
    expect(name).toBe("abcdefghijklm-nopqrstuvw");
  });

  test("falls back to fork for empty/punctuation-only directives", () => {
    expect(deriveForkName("   ")).toBe("fork");
    expect(deriveForkName("!!! ???")).toBe("fork");
  });
});

describe("forkDescriptionFromDirective", () => {
  test("collapses whitespace and truncates at 50 with ellipsis", () => {
    const long = "a".repeat(60);
    expect(forkDescriptionFromDirective(`  hello   world  `)).toBe("hello world");
    expect(forkDescriptionFromDirective(long)).toBe(`${"a".repeat(49)}…`);
  });
});
