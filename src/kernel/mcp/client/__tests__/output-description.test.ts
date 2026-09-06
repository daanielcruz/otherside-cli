import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatDescription,
  formatFileSize,
  inferCompactSchema,
  lineMetaFor,
} from "@/kernel/mcp/client/output/describe.ts";
import {
  type McpOutputContext,
  marshalMcpContent,
  type TransformedMcpResult,
} from "@/kernel/mcp/client/output/handler.ts";
import { persistBinaryBlock } from "@/kernel/mcp/client/output/persist.ts";

function result(type: TransformedMcpResult["type"], schema?: string): TransformedMcpResult {
  return { content: "", type, ...(schema === undefined ? {} : { schema }) };
}

describe("MCP output descriptions", () => {
  test("uses exact format labels and only includes non-empty sample shapes", () => {
    expect(formatDescription(result("toolResult"))).toBe("Plain text");
    expect(formatDescription(result("structuredContent"))).toBe("JSON");
    expect(formatDescription(result("structuredContent", "{id: number}"))).toBe(
      "JSON with schema: {id: number}",
    );
    expect(formatDescription(result("contentArray"))).toBe("JSON array");
    expect(formatDescription(result("contentArray", "[string]"))).toBe(
      "JSON array with schema: [string]",
    );
    expect(formatDescription(result("contentArray", ""))).toBe("JSON array");
  });

  test("describes primitive values and samples only the first array item", () => {
    expect(inferCompactSchema(null)).toBe("null");
    expect(inferCompactSchema(undefined)).toBe("undefined");
    expect(inferCompactSchema(Symbol("sample"))).toBe("symbol");
    expect(inferCompactSchema(1n)).toBe("bigint");
    expect(inferCompactSchema(() => undefined)).toBe("function");
    expect(inferCompactSchema([])).toBe("[]");
    expect(inferCompactSchema([1, "later", false])).toBe("[number]");
  });

  test("preserves insertion order, depth gates, and the ten-member cap", () => {
    const twelveMembers = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`member${index + 1}`, index + 1]),
    );

    expect(inferCompactSchema({ second: 2, first: 1 })).toBe("{second: number, first: number}");
    expect(inferCompactSchema({ outer: { inner: { leaf: true } } })).toBe(
      "{outer: {inner: {...}}}",
    );
    expect(inferCompactSchema({ value: 1 }, 0)).toBe("{...}");
    expect(inferCompactSchema(twelveMembers)).toBe(
      "{member1: number, member2: number, member3: number, member4: number, member5: number, member6: number, member7: number, member8: number, member9: number, member10: number, ...}",
    );
  });

  test("reports line count and longest line including empty content", () => {
    expect(lineMetaFor("")).toEqual({ count: 1, maxLen: 0 });
    expect(lineMetaFor("one")).toEqual({ count: 1, maxLen: 3 });
    expect(lineMetaFor("one\nlonger\n")).toEqual({ count: 2, maxLen: 6 });
    expect(lineMetaFor("one\n\n")).toEqual({ count: 2, maxLen: 3 });
  });

  test("formats byte-unit boundaries and strips zero decimal fractions", () => {
    const cases: Array<[number, string]> = [
      [-1, "-1 bytes"],
      [0, "0 bytes"],
      [1, "1 bytes"],
      [1023, "1023 bytes"],
      [1024, "1KB"],
      [1536, "1.5KB"],
      [1024 ** 2, "1MB"],
      [1024 ** 3, "1GB"],
      [Number.NaN, "NaNGB"],
      [Number.POSITIVE_INFINITY, "InfinityGB"],
    ];

    for (const [bytes, expected] of cases) expect(formatFileSize(bytes)).toBe(expected);
  });

  test("supplies compact structured shape and line metadata to persisted output", () => {
    const previousDirectory = process.env.OTHERSIDE_TOOL_RESULTS_DIR;
    const previousLimit = process.env.MAX_MCP_OUTPUT_TOKENS;
    const outputRoot = mkdtempSync(join(tmpdir(), "otherside-mcp-description-"));
    const context: McpOutputContext = {
      cwd: outputRoot,
      sessionId: "session",
      serverName: "sample-server",
      toolName: "sample-tool",
      toolUseId: "sample-use",
    };

    try {
      process.env.OTHERSIDE_TOOL_RESULTS_DIR = outputRoot;
      process.env.MAX_MCP_OUTPUT_TOKENS = "1";
      const marshaled = marshalMcpContent(
        {
          structuredContent: { item: { id: 1, ignoredDepth: { leaf: true } } },
        },
        context,
      );

      expect(marshaled.content).toContain(
        "result (79 characters across 8 lines) exceeds maximum allowed tokens",
      );
      expect(marshaled.content).toContain(
        "Format: JSON with schema: {item: {id: number, ignoredDepth: {...}}}",
      );
    } finally {
      if (previousDirectory === undefined) delete process.env.OTHERSIDE_TOOL_RESULTS_DIR;
      else process.env.OTHERSIDE_TOOL_RESULTS_DIR = previousDirectory;
      if (previousLimit === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS;
      else process.env.MAX_MCP_OUTPUT_TOKENS = previousLimit;
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("uses the shared size description in persisted binary output", () => {
    const previousDirectory = process.env.OTHERSIDE_TOOL_RESULTS_DIR;
    const outputRoot = mkdtempSync(join(tmpdir(), "otherside-mcp-binary-"));
    const context: McpOutputContext = {
      cwd: outputRoot,
      sessionId: "session",
      serverName: "sample-server",
      toolName: "sample-tool",
      toolUseId: "sample-use",
    };

    try {
      process.env.OTHERSIDE_TOOL_RESULTS_DIR = outputRoot;
      const binary = persistBinaryBlock(
        Buffer.alloc(1536).toString("base64"),
        "audio/mpeg",
        "",
        context,
      );
      expect(binary.type).toBe("text");
      if (binary.type === "text")
        expect(binary.text).toContain("Binary content (audio/mpeg, 1.5KB)");
    } finally {
      if (previousDirectory === undefined) delete process.env.OTHERSIDE_TOOL_RESULTS_DIR;
      else process.env.OTHERSIDE_TOOL_RESULTS_DIR = previousDirectory;
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
