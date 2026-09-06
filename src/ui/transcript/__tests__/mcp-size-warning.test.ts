import { describe, expect, test } from "bun:test";
import {
  CHARS_PER_TOKEN,
  MCP_WARNING_THRESHOLD_TOKENS,
  mcpSizeWarning,
} from "@/ui/transcript/tool-render/format.ts";
import { payloadFromResult } from "@/ui/transcript/tool-render/payload.ts";

const WIRE = "mcp__server__tool";
const OVER_THRESHOLD_CHARS = (MCP_WARNING_THRESHOLD_TOKENS + 2000) * CHARS_PER_TOKEN;
const big = (): string => "x".repeat(OVER_THRESHOLD_CHARS);

describe("the oversize-response warning", () => {
  test("names the estimate once past the threshold", () => {
    expect(mcpSizeWarning(big())).toContain("Large MCP response");
    expect(mcpSizeWarning("small")).toBeNull();
  });

  test("rides on the rendered result", () => {
    const payload = payloadFromResult({ name: WIRE, content: big(), args: {} });
    expect(payload?.kind).toBe("preview");
    expect((payload as { text: string }).text).toContain("Large MCP response");
  });

  test("stays off an error result, which carries its own message", () => {
    const payload = payloadFromResult({ name: WIRE, content: big(), args: {}, isError: true });
    if (payload) expect((payload as { text: string }).text).not.toContain("Large MCP response");
  });

  test("stays off a tool that is not served over MCP", () => {
    const payload = payloadFromResult({ name: "Bash", content: big(), args: {} });
    if (payload?.kind === "preview") {
      expect(payload.text).not.toContain("Large MCP response");
    }
  });
});

/**
 * The warning only attaches to a payload that resolved as a preview, so a result
 * shape that resolved to any other kind would skip it silently. Every MCP result
 * shape is pinned here: an unparseable body, a wrapped text payload, a flat
 * object, and a nested object too deep to flatten.
 */
describe("every MCP result shape resolves as a preview", () => {
  const shapes: [string, string][] = [
    ["unparseable text", `plain ${big()}`],
    ["wrapped text content", JSON.stringify({ content: [{ type: "text", text: big() }] })],
    ["a flat object", JSON.stringify({ id: 1, body: big() })],
    ["a deeply nested object", JSON.stringify({ a: { b: { c: { d: big() } } } })],
    ["an array", JSON.stringify([big()])],
  ];

  for (const [label, content] of shapes) {
    test(`${label} warns`, () => {
      const payload = payloadFromResult({ name: WIRE, content, args: {} });
      expect(payload?.kind).toBe("preview");
      expect((payload as { text: string }).text).toContain("Large MCP response");
    });
  }

  test("an empty body resolves to nothing, and has nothing to warn about", () => {
    expect(payloadFromResult({ name: WIRE, content: "", args: {} })).toBeNull();
  });
});
