import { describe, expect, test } from "bun:test";
import { mcpConnectivityNotices } from "@/kernel/mcp/errors/warnings.ts";
import type { McpConnectivityReport } from "@/kernel/mcp/runtime/manager.ts";

function report(overrides: Partial<McpConnectivityReport> = {}): McpConnectivityReport {
  return { connected: [], failed: [], needsAuth: [], ...overrides };
}

describe("mcpConnectivityNotices", () => {
  test("says nothing when every configured server connected", () => {
    expect(mcpConnectivityNotices(report({ connected: ["alpha"] }))).toEqual([]);
  });

  test("leaves a refused connection to the transient surface", () => {
    expect(
      mcpConnectivityNotices(
        report({
          failed: [
            { server: "alpha", error: "spawn failed" },
            { server: "beta", error: "spawn failed" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("names the unauthenticated count, singular", () => {
    expect(
      mcpConnectivityNotices(
        report({
          failed: [{ server: "alpha", error: "spawn failed" }],
          needsAuth: [{ server: "beta", error: "401" }],
        }),
      ),
    ).toEqual(["1 MCP server needs auth · /mcp"]);
  });

  test("pluralizes the unauthenticated count", () => {
    expect(
      mcpConnectivityNotices(
        report({
          needsAuth: [
            { server: "gamma", error: "401" },
            { server: "delta", error: "401" },
          ],
        }),
      ),
    ).toEqual(["2 MCP servers need auth · /mcp"]);
  });
});
