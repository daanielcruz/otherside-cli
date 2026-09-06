import { describe, expect, it } from "bun:test";
import type { McpServerInspection, McpToolInfo } from "@/kernel/mcp/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import type { McpServerRow } from "@/ui/panels/mcp/data.ts";
import { renderMcpToolsList } from "@/ui/panels/mcp/tools.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const WIDTH = 80;
const TERMINAL_ROWS = 30;

const tool = (index: number): McpToolInfo => ({
  name: `tool-${index}`,
  description: `placeholder tool ${index}`,
  inputSchema: {},
});

const serverWithTools = (count: number): McpServerRow => {
  const inspection: McpServerInspection = {
    status: "connected",
    statusText: "connected",
    tools: Array.from({ length: count }, (_, index) => tool(index)),
    error: null,
  };
  return {
    name: "placeholder-server",
    config: { type: "stdio", command: "placeholder", args: [] },
    enabled: true,
    inspection,
  };
};

const render = (count: number, toolIndex: number): string[] =>
  renderMcpToolsList({
    server: serverWithTools(count),
    toolIndex,
    terminalRows: TERMINAL_ROWS,
    width: WIDTH,
  }).map(stripAnsi);

describe("mcp tools list window", () => {
  it("shows the shared overflow markers instead of per-row arrows", () => {
    const lines = render(9, 6);
    expect(lines.some((line) => line.includes("↑ more above"))).toBe(true);
    expect(lines.some((line) => line.includes("↓ more below"))).toBe(true);
    // The arrow never leaks into a tool row's marker column.
    expect(lines.some((line) => /^\s*[↑↓]\s+\d+\./.test(line))).toBe(false);
  });

  it("omits markers when every tool fits", () => {
    const lines = render(3, 1);
    expect(lines.some((line) => line.includes("more above"))).toBe(false);
    expect(lines.some((line) => line.includes("more below"))).toBe(false);
  });

  it("keeps the selection chevron and shows the shared counter", () => {
    const lines = render(9, 6);
    expect(lines.some((line) => line.includes("(7/9)"))).toBe(true);
    const chevron = Glyph.chevron.trimEnd();
    expect(lines.some((line) => line.trimStart().startsWith(`${chevron} 7.`))).toBe(true);
  });

  it("keeps the cursor row inside the window at the edges", () => {
    const top = render(9, 0);
    expect(top.some((line) => line.includes("1. tool-0"))).toBe(true);
    expect(top.some((line) => line.includes("more above"))).toBe(false);

    const bottom = render(9, 8);
    expect(bottom.some((line) => line.includes("9. tool-8"))).toBe(true);
    expect(bottom.some((line) => line.includes("more below"))).toBe(false);
  });
});
