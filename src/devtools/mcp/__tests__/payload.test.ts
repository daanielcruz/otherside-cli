import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMcpPayload } from "@/devtools/mcp/payload.ts";

const roots: string[] = [];
const savedPath = process.env.OTHERSIDE_MCP_PAYLOAD_DIAG;

afterEach(() => {
  if (savedPath === undefined) delete process.env.OTHERSIDE_MCP_PAYLOAD_DIAG;
  else process.env.OTHERSIDE_MCP_PAYLOAD_DIAG = savedPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP payload diagnostics", () => {
  it("records payload sizes without recording payload content", () => {
    const root = mkdtempSync(join(tmpdir(), "otherside-mcp-payload-test-"));
    roots.push(root);
    const path = join(root, "payload.jsonl");
    process.env.OTHERSIDE_MCP_PAYLOAD_DIAG = path;
    const text = "é".repeat(4_096);
    const context = {
      serverName: "fixture",
      toolName: "large_result",
      toolUseId: "call-1",
    };

    recordMcpPayload("transport-result", { content: [{ type: "text", text }] }, context);
    recordMcpPayload("returned-result", "saved to fixture", context);

    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      stage: "transport-result",
      ...context,
      stringBytes: Buffer.byteLength("text", "utf8") + Buffer.byteLength(text, "utf8"),
      largestStringBytes: Buffer.byteLength(text, "utf8"),
    });
    expect(records[1]).toMatchObject({
      stage: "returned-result",
      ...context,
      stringBytes: Buffer.byteLength("saved to fixture", "utf8"),
    });
    expect(readFileSync(path, "utf8")).not.toContain(text);
  });
});
