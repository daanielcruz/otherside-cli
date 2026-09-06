import { afterEach, describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { register, unregister } from "@/engine/tools/registry.ts";
import { makeMcpRenderHooks } from "@/kernel/mcp/index.ts";
import { formatToolLines } from "@/ui/transcript/string-view-tool.ts";
import { buildToolEntryData } from "@/ui/transcript/tool-entry-data.ts";
import { formatHeadRows } from "@/ui/transcript/tool-render/head.ts";
import { resolveToolLabel } from "@/ui/transcript/tool-render/label.ts";

const SERVER = "plugin:playwright@claude-plugins-official:playwright";
const WIRE = "mcp__plugin_playwright_claude-plugins-official_playwright__browser_evaluate";
const LIVE_LABEL = "plugin:playwright:playwright - Evaluate JavaScript (MCP)";
const WIRE_LABEL = "plugin_playwright_claude-plugins-official_playwright - browser_evaluate (MCP)";

const IDENTITY = { server: SERVER, tool: "Evaluate JavaScript" };

function registerServingTool(): void {
  register({
    schema: { name: WIRE, description: "", inputSchema: { type: "object" } },
    render: makeMcpRenderHooks(SERVER, {
      name: "browser_evaluate",
      title: "Evaluate JavaScript",
      description: "",
    }),
    run: async () => ({ tool_use_id: "x", content: "" }),
  });
}

// The registry is global and the suite shares one process, so a tool left
// registered here joins the roster every later assembly snapshot measures.
afterEach(() => {
  unregister(WIRE);
});

describe("MCP label resolution", () => {
  test("a serving server names the call", () => {
    registerServingTool();
    expect(resolveToolLabel({ name: WIRE, args: {} })).toBe(LIVE_LABEL);
  });

  test("a stored identity names the call once the server is gone", () => {
    expect(resolveToolLabel({ name: WIRE, args: {}, mcpIdentity: IDENTITY })).toBe(LIVE_LABEL);
  });

  test("without an identity the wire name is all that is left", () => {
    expect(resolveToolLabel({ name: WIRE, args: {} })).toBe(WIRE_LABEL);
  });

  test("a serving server outranks a stored identity that has drifted", () => {
    registerServingTool();
    const stale = { server: "old:name", tool: "Old Title" };
    expect(resolveToolLabel({ name: WIRE, args: {}, mcpIdentity: stale })).toBe(LIVE_LABEL);
  });
});

describe("MCP header rendering", () => {
  const base: TranscriptEntry = {
    id: "r_call_1",
    kind: "tool",
    title: WIRE,
    text: "done",
    input: JSON.stringify({ function: "async () => 1" }),
  };

  function headOf(entry: TranscriptEntry): string {
    const data = buildToolEntryData(entry);
    expect(data).not.toBeNull();
    return formatHeadRows(data!, 200, "compact")[0]!.replace(/\x1b\[[0-9;]*m/g, "");
  }

  test("a resumed call carrying an identity keeps its declared name", () => {
    expect(headOf({ ...base, mcpIdentity: IDENTITY })).toContain(LIVE_LABEL);
  });

  test("a call recorded without an identity renders as it always did", () => {
    expect(headOf(base)).toContain(WIRE_LABEL);
  });
});

describe("MCP nested rows", () => {
  const agentCall: TranscriptEntry = {
    id: "r_call_2",
    kind: "tool",
    title: "Agent",
    text: "",
    input: JSON.stringify({ description: "probe" }),
  };

  function nestedRowsOf(nested: NonNullable<TranscriptEntry["nested"]>): string[] {
    const data = buildToolEntryData({ ...agentCall, nested });
    expect(data).not.toBeNull();
    return formatToolLines(data!, 200, "detailed").map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  }

  test("a folded row carries its identity once its server is gone", () => {
    const rows = nestedRowsOf([
      { toolName: WIRE, args: {}, running: false, mcpIdentity: IDENTITY },
    ]);
    expect(rows.some((row) => row.includes(LIVE_LABEL))).toBe(true);
  });

  test("a row recorded without an identity renders as it always did", () => {
    const rows = nestedRowsOf([{ toolName: WIRE, args: {}, running: false }]);
    expect(rows.some((row) => row.includes(WIRE_LABEL))).toBe(true);
  });

  test("a serving server names the row without any stored identity", () => {
    registerServingTool();
    const rows = nestedRowsOf([{ toolName: WIRE, args: {}, running: false }]);
    expect(rows.some((row) => row.includes(LIVE_LABEL))).toBe(true);
  });
});
