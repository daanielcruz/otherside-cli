import { describe, expect, it } from "bun:test";
import stripAnsi from "strip-ansi";
import type { McpServerRow } from "@/ui/panels/mcp/data.ts";
import { mcpDetailView } from "@/ui/panels/plugins/mcp-detail.ts";

function connectedServer(): McpServerRow {
  return {
    name: "docs",
    config: { type: "stdio", command: "docs-server", args: [], env: {} },
    enabled: true,
    inspection: {
      status: "connected",
      tools: [{ name: "lookup", description: "", inputSchema: {} }],
    },
  } as unknown as McpServerRow;
}

describe("mcpDetailView", () => {
  it("shares the decorated server-info renderer with the MCP panel", () => {
    const view = mcpDetailView({
      server: connectedServer(),
      contentWidth: 60,
      busy: null,
      menuIndex: 0,
    });
    const text = view.body.map((line) => stripAnsi(line)).join("\n");
    expect(text).toContain("✔ connected");
    expect(text).toContain("Capabilities");
    expect(text).not.toMatch(/Status\s+connected\b/);
  });
});
