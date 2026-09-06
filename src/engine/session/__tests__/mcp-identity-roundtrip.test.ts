import { describe, expect, it } from "bun:test";
import { recordsFromParsedLine } from "@/engine/session/record/reader.ts";
import type { ToolCallRecord } from "@/engine/session/record/schema.ts";
import { serializeRecord } from "@/engine/session/record/serializers.ts";
import { SessionChain } from "@/engine/session/record/state.ts";

const WIRE = "mcp__plugin_playwright_claude-plugins-official_playwright__browser_evaluate";
const IDENTITY = {
  server: "plugin:playwright@claude-plugins-official:playwright",
  tool: "Evaluate JavaScript",
};

function callRecord(extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    type: "tool_call",
    ts: "2026-07-02T12:00:00.000Z",
    tool_name: WIRE,
    args: { function: "async () => 1" },
    call_id: "call_1",
    ...extra,
  };
}

function writeAndRead(record: ToolCallRecord): {
  line: Record<string, unknown>;
  call: ToolCallRecord | undefined;
} {
  const text = serializeRecord(record, new SessionChain(), { sessionId: "s1", cwd: "/tmp" });
  const line = JSON.parse(text) as Record<string, unknown>;
  const call = recordsFromParsedLine(line).find((r): r is ToolCallRecord => r.type === "tool_call");
  return { line, call };
}

describe("MCP call identity persistence", () => {
  it("survives serialize -> parse as written", () => {
    expect(writeAndRead(callRecord({ mcpIdentity: IDENTITY })).call?.mcpIdentity).toEqual(IDENTITY);
  });

  it("is absent from a call that never had one", () => {
    const { line, call } = writeAndRead(callRecord());
    expect(call?.mcpIdentity).toBeUndefined();
    expect(JSON.stringify(line).includes("mcpIdentity")).toBe(false);
  });

  it("rides the sidecar and leaves the tool_use block untouched", () => {
    const { line } = writeAndRead(callRecord({ mcpIdentity: IDENTITY }));
    const message = line.message as { content: Record<string, unknown>[] };
    expect(Object.keys(message.content[0]!).sort()).toEqual(["id", "input", "name", "type"]);
    expect((line._os as Record<string, unknown>).mcpIdentity).toEqual(IDENTITY);
  });

  it("drops a stored identity that is not one", () => {
    const { line } = writeAndRead(callRecord());
    (line._os as Record<string, unknown>).mcpIdentity = { server: 42 };
    const call = recordsFromParsedLine(line).find(
      (r): r is ToolCallRecord => r.type === "tool_call",
    );
    expect(call?.mcpIdentity).toBeUndefined();
  });

  it("never claims an identity for a call that is not an MCP call", () => {
    const { line } = writeAndRead(callRecord({ tool_name: "Bash" }));
    (line._os as Record<string, unknown>).mcpIdentity = IDENTITY;
    const call = recordsFromParsedLine(line).find(
      (r): r is ToolCallRecord => r.type === "tool_call",
    );
    expect(call?.mcpIdentity).toBeUndefined();
  });
});
