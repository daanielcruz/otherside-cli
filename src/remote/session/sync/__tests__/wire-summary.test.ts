import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { __test } from "./test-helpers.ts";

const { wireToolCallSummary } = __test;

// getDisplayPath renders paths under the process cwd as relative; the summary
// must never leak the absolute prefix the companion cannot shorten itself.
const underCwd = (rel: string): string => join(process.cwd(), rel);

describe("wireToolCallSummary", () => {
  test("Edit/Write/MultiEdit render the cwd-relative path, not the absolute one", () => {
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      const summary = wireToolCallSummary(tool, { file_path: underCwd("src/app.ts") });
      expect(summary).toBe("src/app.ts");
    }
  });

  test("Read appends a line/page qualifier", () => {
    const path = underCwd("docs/readme.md");
    expect(wireToolCallSummary("Read", { file_path: path })).toBe("docs/readme.md");
    expect(wireToolCallSummary("Read", { file_path: path, offset: 10, limit: 5 })).toBe(
      "docs/readme.md · lines 10-14",
    );
    expect(wireToolCallSummary("Read", { file_path: path, pages: "1-3" })).toBe(
      "docs/readme.md · pages 1-3",
    );
  });

  test("Bash summarizes the first command line", () => {
    expect(wireToolCallSummary("Bash", { command: "ls -la\ncd /tmp" })).toBe("ls -la");
  });

  test("Agent/WebFetch/WebSearch pull their descriptive arg", () => {
    expect(wireToolCallSummary("Agent", { description: "audit auth" })).toBe("audit auth");
    expect(wireToolCallSummary("WebFetch", { url: "https://x.dev" })).toBe("https://x.dev");
    expect(wireToolCallSummary("WebSearch", { query: "rust async" })).toBe("rust async");
  });

  test("LSP reads the camelCase filePath arg with the operation", () => {
    expect(wireToolCallSummary("LSP", { operation: "hover", filePath: underCwd("src/x.ts") })).toBe(
      "hover src/x.ts",
    );
  });

  test("unknown tools and missing args fall back to an empty summary", () => {
    expect(wireToolCallSummary("Bash", null)).toBe("");
    expect(wireToolCallSummary("SomeFutureTool", { file_path: underCwd("x") })).toBe("");
    expect(wireToolCallSummary("Edit", {})).toBe("");
  });
});
