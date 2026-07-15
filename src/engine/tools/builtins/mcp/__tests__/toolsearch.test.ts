import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { keywordSearch, ToolSearch } from "../toolsearch.ts";

describe("keywordSearch ranking", () => {
  const pool = [
    { name: "NotebookEdit", description: "Edit a Jupyter notebook cell", input_schema: {} },
    { name: "WebSearch", description: "Search the web for pages", input_schema: {} },
    { name: "Read", description: "Read a file from disk", input_schema: {} },
  ];

  test("a multi-word query matches by keyword, not whole-string substring", () => {
    // "notebook jupyter" is not a literal substring of any name/description,
    // but both terms hit NotebookEdit.
    expect(keywordSearch(pool, "notebook jupyter").map((e) => e.name)).toEqual(["NotebookEdit"]);
  });

  test("ranks the strongest match first", () => {
    // "search web" hits WebSearch on both terms; "web" alone would also weakly
    // touch nothing else here.
    expect(keywordSearch(pool, "search web")[0]?.name).toBe("WebSearch");
  });

  test("a `+term` requires the term in the NAME", () => {
    // +web requires "web" in the name -> only WebSearch qualifies, even though
    // "search" also appears in its description.
    expect(keywordSearch(pool, "+web search").map((e) => e.name)).toEqual(["WebSearch"]);
  });

  test("returns nothing when no term matches", () => {
    expect(keywordSearch(pool, "kubernetes")).toEqual([]);
  });
});

describe("MCP catalog permissions", () => {
  test("omits blanket-denied MCP tools from ToolSearch", async () => {
    const name = "mcp__github__delete_issue";
    const configDir = mkdtempSync(join(tmpdir(), "otherside-toolsearch-config-"));
    const workspace = mkdtempSync(join(tmpdir(), "otherside-toolsearch-workspace-"));
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ permissions: { deny: [name] } }),
    );
    toolRegistry.registerWithNamespace("mcp:github", {
      schema: {
        name,
        description: "Delete a GitHub issue.",
        inputSchema: { type: "object", properties: {} },
      },
      async run(call) {
        return { tool_use_id: call.id, content: "" };
      },
    });

    try {
      const result = await ToolSearch.run(
        { id: "toolsearch-deny", name: "ToolSearch", input: { query: `select:${name}` } },
        {
          provider: "anthropic",
          model: "claude-opus-4-8",
          effort: null,
          permissionMode: "default",
          sessionId: "toolsearch-deny",
          cwd: workspace,
        },
      );
      if (typeof result.content !== "string") throw new Error("expected ToolSearch JSON content");
      expect(JSON.parse(result.content)).toMatchObject({ tools: [] });

      writeFileSync(
        join(configDir, "settings.json"),
        JSON.stringify({ permissions: { ask: [name] } }),
      );
      const askResult = await ToolSearch.run(
        { id: "toolsearch-ask", name: "ToolSearch", input: { query: `select:${name}` } },
        {
          provider: "anthropic",
          model: "claude-opus-4-8",
          effort: null,
          permissionMode: "default",
          sessionId: "toolsearch-ask",
          cwd: workspace,
        },
      );
      if (typeof askResult.content !== "string")
        throw new Error("expected ToolSearch JSON content");
      expect(JSON.parse(askResult.content)).toMatchObject({ tools: [{ name }] });
    } finally {
      toolRegistry.unregister(name);
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
