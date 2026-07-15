import { describe, expect, it } from "bun:test";
import {
  hasDirectoryReadCapability,
  hasResourcesCapability,
  parseDirectoryEntry,
  parseServerCapabilities,
  sanitizeMcpText,
  sanitizeMcpUri,
} from "@/kernel/mcp/protocol/parse.ts";
import {
  MCP_SKILLS_EXTENSION_URI,
  type McpServerCapabilities,
} from "@/kernel/mcp/protocol/types.ts";

describe("MCP capability + directory parsers", () => {
  it("parseServerCapabilities extracts initialize.capabilities", () => {
    const caps = parseServerCapabilities({
      protocolVersion: "2024-11-05",
      capabilities: { resources: {}, tools: {} },
    });
    expect(caps).toEqual({ resources: {}, tools: {} });
    expect(hasResourcesCapability(caps)).toBe(true);
  });

  it("hasResourcesCapability is false without resources", () => {
    expect(hasResourcesCapability(null)).toBe(false);
    expect(hasResourcesCapability({ tools: {} })).toBe(false);
    expect(hasResourcesCapability({ resources: true })).toBe(true);
  });

  it("hasDirectoryReadCapability requires skills extension directoryRead:true", () => {
    const base: McpServerCapabilities = { resources: {} };
    expect(hasDirectoryReadCapability(base)).toBe(false);
    expect(
      hasDirectoryReadCapability({
        resources: {},
        extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: false } },
      }),
    ).toBe(false);
    expect(
      hasDirectoryReadCapability({
        resources: {},
        extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
      }),
    ).toBe(true);
  });

  it("parseDirectoryEntry requires uri + name", () => {
    expect(parseDirectoryEntry({ uri: "file://x" })).toBeNull();
    expect(parseDirectoryEntry({ name: "x" })).toBeNull();
    expect(
      parseDirectoryEntry({ uri: "file://x", name: "x", mimeType: "inode/directory" }),
    ).toEqual({
      uri: "file://x",
      name: "x",
      mimeType: "inode/directory",
    });
  });

  it("sanitizeMcpText strips bidi/format controls", () => {
    expect(sanitizeMcpText("a\u200Bb\u202Ec")).toBe("abc");
  });

  it("sanitizeMcpUri decodes then sanitizes", () => {
    expect(sanitizeMcpUri("file://x%2Fy")).toBe("file://x/y");
  });
});
