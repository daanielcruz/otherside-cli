import { describe, expect, it } from "bun:test";
import { isImmediateSlash } from "@/commands/immediate.ts";

describe("isImmediateSlash immediate-slash gating", () => {
  it("goal is immediate", () => expect(isImmediateSlash("/goal tests pass")).toBe(true));
  it("effort (panel) is immediate", () => expect(isImmediateSlash("/effort high")).toBe(true));
  it("compact (anchor) is NOT immediate", () => expect(isImmediateSlash("/compact")).toBe(false));
  it("branch (anchor) is NOT immediate", () => expect(isImmediateSlash("/branch")).toBe(false));
  it("plain text is not immediate", () => expect(isImmediateSlash("hello")).toBe(false));
});
