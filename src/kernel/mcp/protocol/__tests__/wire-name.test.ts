import { describe, expect, test } from "bun:test";
import { displayMcpServerName } from "@/kernel/mcp/protocol/wire-name.ts";

describe("displayMcpServerName", () => {
  test("strips the marketplace qualifier from a plugin server key", () => {
    expect(displayMcpServerName("plugin:playwright@claude-plugins-official:playwright")).toBe(
      "plugin:playwright:playwright",
    );
  });

  test("keeps a multi-segment server suffix intact", () => {
    expect(displayMcpServerName("plugin:foo@mp:bar:baz")).toBe("plugin:foo:bar:baz");
  });

  test("leaves a plugin key without a qualifier unchanged", () => {
    expect(displayMcpServerName("plugin:playwright:playwright")).toBe(
      "plugin:playwright:playwright",
    );
  });

  test("passes through non-plugin server names", () => {
    expect(displayMcpServerName("context7")).toBe("context7");
    expect(displayMcpServerName("ida-pro-mcp")).toBe("ida-pro-mcp");
  });
});
