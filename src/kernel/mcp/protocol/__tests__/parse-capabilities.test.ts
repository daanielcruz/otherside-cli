import { afterEach, describe, expect, it } from "bun:test";
import {
  hasResourcesCapability,
  isMcpSkillsEnabled,
  parseDirectoryEntry,
  parseServerCapabilities,
  sanitizeMcpText,
  sanitizeMcpUri,
  setMcpSkillsEnabledForTests,
  supportsResourceDirectoryRead,
} from "@/kernel/mcp/protocol/parse.ts";
import {
  MCP_SKILLS_EXTENSION_URI,
  type McpServerCapabilities,
} from "@/kernel/mcp/protocol/types.ts";

describe("MCP capability + directory parsers", () => {
  afterEach(() => setMcpSkillsEnabledForTests(null));

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

  it("keeps the tengu_mcp_skills gate independent from server capabilities", () => {
    setMcpSkillsEnabledForTests(false);
    expect(isMcpSkillsEnabled()).toBe(false);
    setMcpSkillsEnabledForTests(true);
    expect(isMcpSkillsEnabled()).toBe(true);
  });

  it("supportsResourceDirectoryRead requires skills extension directoryRead:true", () => {
    const base: McpServerCapabilities = { resources: {} };
    expect(supportsResourceDirectoryRead(base)).toBe(false);
    expect(
      supportsResourceDirectoryRead({
        resources: {},
        extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: false } },
      }),
    ).toBe(false);
    expect(
      supportsResourceDirectoryRead({
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

  it("sanitizeMcpUri preserves percent-encoding while stripping controls", () => {
    expect(sanitizeMcpUri("file://x%2Fy\u200B")).toBe("file://x%2Fy");
  });
});
