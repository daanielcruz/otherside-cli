import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeDeferredToolNames, clearDeferredAnnouncements } from "@/engine/tools/deferred.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { EnterWorktree } from "../../worktree-enter.ts";
import { ExitWorktree } from "../../worktree-exit.ts";
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

describe("deferred tool references", () => {
  test("loads EnterWorktree and ExitWorktree by exact select query", async () => {
    const hadEnter = toolRegistry.get("EnterWorktree") !== undefined;
    const hadExit = toolRegistry.get("ExitWorktree") !== undefined;
    if (!hadEnter) toolRegistry.registerWithNamespace("builtin", EnterWorktree);
    if (!hadExit) toolRegistry.registerWithNamespace("builtin", ExitWorktree);
    clearDeferredAnnouncements();
    try {
      const result = await ToolSearch.run(
        {
          id: "toolsearch-worktrees",
          name: "ToolSearch",
          input: { query: "select:EnterWorktree,ExitWorktree" },
        },
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: null,
          permissionMode: "default",
          sessionId: "toolsearch-worktrees",
          cwd: process.cwd(),
        },
      );
      expect(result.content).toEqual([
        { type: "tool_reference", tool_name: "EnterWorktree" },
        { type: "tool_reference", tool_name: "ExitWorktree" },
      ]);
      expect(activeDeferredToolNames()).toEqual(["EnterWorktree", "ExitWorktree"]);
    } finally {
      clearDeferredAnnouncements();
      if (!hadEnter) toolRegistry.unregister("EnterWorktree");
      if (!hadExit) toolRegistry.unregister("ExitWorktree");
    }
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
      expect(result.content).toBe("No matching deferred tools found");

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
      expect(askResult.content).toEqual([{ type: "tool_reference", tool_name: name }]);
    } finally {
      toolRegistry.unregister(name);
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
