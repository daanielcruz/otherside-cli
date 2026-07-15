import { describe, expect, test } from "bun:test";
import { parseMcpServerSpec } from "@/kernel/mcp/config.ts";
import { loadFromMarkdown } from "../loader.ts";
import { mcpServerSpecName } from "../registry.ts";

describe("parseMcpServerSpec", () => {
  test("returns a bare string as a name reference", () => {
    expect(parseMcpServerSpec("slack")).toBe("slack");
    expect(parseMcpServerSpec("  github  ")).toBe("github");
  });

  test("parses an inline stdio config object", () => {
    const spec = parseMcpServerSpec('{"playwright": {"command": "npx", "args": ["-y", "mcp"]}}');
    expect(spec).toEqual({ playwright: { type: "stdio", command: "npx", args: ["-y", "mcp"] } });
  });

  test("parses an inline http config object", () => {
    const spec = parseMcpServerSpec('{"docs": {"type": "http", "url": "https://api.example/mcp"}}');
    expect(spec).toEqual({ docs: { type: "http", url: "https://api.example/mcp" } });
  });

  test("rejects malformed JSON, multi-key objects, and unparsable configs", () => {
    expect(parseMcpServerSpec("{not json")).toBeNull();
    expect(parseMcpServerSpec('{"a": {"command": "x"}, "b": {"command": "y"}}')).toBeNull();
    expect(parseMcpServerSpec('{"bad": {"type": "stdio"}}')).toBeNull();
    expect(parseMcpServerSpec("")).toBeNull();
  });
});

describe("mcpServerSpecName", () => {
  test("yields the name for both string refs and inline configs", () => {
    expect(mcpServerSpecName("slack")).toBe("slack");
    expect(mcpServerSpecName({ playwright: { type: "stdio", command: "npx", args: [] } })).toBe(
      "playwright",
    );
  });
});

describe("agent manifest mcpServers + maxTurns", () => {
  function agentSrc(body: string): string {
    return `---\nname: tester\ndescription: a test agent\n${body}\n---\nbody text`;
  }

  test("mixes string refs and inline configs in a block list", () => {
    const def = loadFromMarkdown(
      "tester",
      agentSrc(
        'mcpServers:\n  - slack\n  - {"playwright": {"command": "npx", "args": ["-y", "mcp"]}}',
      ),
    );
    expect(def.mcpServers).toEqual([
      "slack",
      { playwright: { type: "stdio", command: "npx", args: ["-y", "mcp"] } },
    ]);
  });

  test("drops invalid inline configs but keeps valid entries", () => {
    const def = loadFromMarkdown(
      "tester",
      agentSrc('mcpServers:\n  - slack\n  - {"broken": {"type": "stdio"}}'),
    );
    expect(def.mcpServers).toEqual(["slack"]);
  });

  test("parses a positive-integer maxTurns", () => {
    const def = loadFromMarkdown("tester", agentSrc("maxTurns: 4"));
    expect(def.maxTurns).toBe(4);
  });

  test("ignores non-positive or non-integer maxTurns", () => {
    expect(loadFromMarkdown("tester", agentSrc("maxTurns: 0")).maxTurns).toBeUndefined();
    expect(loadFromMarkdown("tester", agentSrc("maxTurns: -3")).maxTurns).toBeUndefined();
    expect(loadFromMarkdown("tester", agentSrc("maxTurns: abc")).maxTurns).toBeUndefined();
  });

  test("omits maxTurns when absent", () => {
    expect(loadFromMarkdown("tester", agentSrc("model: inherit")).maxTurns).toBeUndefined();
  });

  test("parses background: true and defaults it to false", () => {
    expect(loadFromMarkdown("tester", agentSrc("background: true")).background).toBe(true);
    expect(loadFromMarkdown("tester", agentSrc("model: inherit")).background).toBe(false);
  });
});
