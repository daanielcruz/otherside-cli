import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clear as clearPlugins } from "@/engine/plugins/registry.ts";
import { BUILTINS } from "@/engine/tools/builtins/index.ts";
import { allSchemas, BASE_TOOL_NAMES, deferredToolNames } from "@/engine/tools/index.ts";
import { setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import { clientFor, closeAllClients, type McpClient } from "@/kernel/mcp/index.ts";

// Declaration↔handler bridge (ROADMAP NOW #3). The LLM-facing catalog
// (TOOL_CATALOG → BASE/DEFERRED_TOOL_NAMES) and the engine handler set
// (BUILTINS) are maintained as separate lists; this test is the contract that
// keeps them from silently desyncing. `assertBuiltinsHaveSchemas` enforces the
// handler→declaration half at boot — pinned here too — and this adds the
// declaration→handler half, which nothing else checks. Adding a tool that
// touches only one side now fails a test instead of shipping a half-wired tool.

function catalogNames(): ReadonlySet<string> {
  return new Set([...BASE_TOOL_NAMES, ...deferredToolNames()]);
}

const allSchemaNames = allSchemas.map((schema) => schema.name);
const registeredSchemaNames: ReadonlySet<string> = new Set(allSchemaNames);
const builtinHandlerNames: ReadonlySet<string> = new Set(BUILTINS.map((h) => h.schema.name));
const TASK_TOOL_NAMES = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;
const MCP_RESOURCE_TOOL_NAMES = [
  "ListMcpResourcesTool",
  "ReadMcpResourceDirTool",
  "ReadMcpResourceTool",
] as const;
const CONNECTED_MCP_CLIENT: McpClient = {
  async listTools() {
    return [];
  },
  async callTool() {
    return null;
  },
  async listResources() {
    return [];
  },
  async readResource() {
    return null;
  },
  async listDirectory() {
    return { resources: [] };
  },
  serverCapabilities() {
    return { resources: {} };
  },
  serverInstructions() {
    return null;
  },
  async listPrompts() {
    return [];
  },
  async getPrompt() {
    return { messages: [] };
  },
  announce(): void {},
  isClosed() {
    return false;
  },
  close() {},
};

// Declarations the LLM sees that have NO engine builtin handler. Each must carry
// a justification — e.g. design-scoped tools (DESIGN_SCOPED_TOOL_NAMES in
// builtins/toolsearch.ts) surfaced only inside a design session and handled by
// the design subsystem. Empty today; a new entry forces a reviewer to state why
// a declared tool has no handler.
const DECLARED_WITHOUT_BUILTIN_HANDLER: ReadonlySet<string> = new Set<string>();

describe("tool catalog ↔ handler bridge (gates #3)", () => {
  beforeEach(async () => {
    clearPlugins();
    await closeAllClients();
  });

  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
  });

  it("exposes worktree tools in the deferred order with handlers", () => {
    const names = deferredToolNames();
    expect(names.indexOf("EnterWorktree")).toBe(names.indexOf("EnterPlanMode") + 1);
    expect(names.indexOf("ExitWorktree")).toBe(names.indexOf("ExitPlanMode") + 1);
    for (const name of ["EnterWorktree", "ExitWorktree"]) {
      expect(registeredSchemaNames.has(name)).toBe(true);
      expect(builtinHandlerNames.has(name)).toBe(true);
    }
  });

  it("planning task tools are default-on and drop only on an explicit falsy kill-switch", () => {
    const planningTools = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];
    const saved = process.env.CLAUDE_CODE_ENABLE_TASKS;
    try {
      delete process.env.CLAUDE_CODE_ENABLE_TASKS;
      for (const name of planningTools) expect(deferredToolNames()).toContain(name);

      // A truthy value keeps them (only an explicit falsy disables).
      process.env.CLAUDE_CODE_ENABLE_TASKS = "1";
      for (const name of planningTools) expect(deferredToolNames()).toContain(name);

      process.env.CLAUDE_CODE_ENABLE_TASKS = "false";
      const disabled = deferredToolNames();
      for (const name of planningTools) expect(disabled).not.toContain(name);
      // The runtime task tools are not covered by the switch.
      expect(disabled).toContain("TaskOutput");
      expect(disabled).toContain("TaskStop");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_ENABLE_TASKS;
      else process.env.CLAUDE_CODE_ENABLE_TASKS = saved;
    }
  });

  it("exposes ScheduleWakeup in the base order with a handler", () => {
    expect(BASE_TOOL_NAMES).toContain("ScheduleWakeup");
    expect(deferredToolNames()).not.toContain("ScheduleWakeup");
    expect(builtinHandlerNames.has("ScheduleWakeup")).toBe(true);
    expect(BASE_TOOL_NAMES.indexOf("ScheduleWakeup")).toBe(
      BASE_TOOL_NAMES.indexOf("ReportFindings") + 1,
    );
    expect(BASE_TOOL_NAMES.indexOf("ScheduleWakeup")).toBeLessThan(
      BASE_TOOL_NAMES.indexOf("Skill"),
    );
  });

  it("gates all MCP resource tools on a connected resources-capable server", async () => {
    for (const name of MCP_RESOURCE_TOOL_NAMES) {
      expect(deferredToolNames()).not.toContain(name);
      expect(registeredSchemaNames.has(name)).toBe(true);
      expect(builtinHandlerNames.has(name)).toBe(true);
    }

    setMcpClientSpawnerForTests(async () => CONNECTED_MCP_CLIENT);
    await clientFor("resources", {
      type: "stdio",
      command: "mcp-server",
      args: [],
    });

    const names = deferredToolNames();
    for (const name of MCP_RESOURCE_TOOL_NAMES) expect(names).toContain(name);
    expect(names.indexOf("NotebookEdit")).toBe(names.indexOf("ListMcpResourcesTool") + 1);
    expect(names.indexOf("ReadMcpResourceDirTool")).toBe(names.indexOf("NotebookEdit") + 1);
    expect(names.indexOf("ReadMcpResourceTool")).toBe(names.indexOf("ReadMcpResourceDirTool") + 1);
  });

  it("exposes SendMessage and Task tools as implemented deferred tools", () => {
    expect(BASE_TOOL_NAMES).not.toContain("SendMessage");
    expect(deferredToolNames()).toContain("SendMessage");
    expect(builtinHandlerNames.has("SendMessage")).toBe(true);

    for (const name of TASK_TOOL_NAMES) {
      expect(BASE_TOOL_NAMES).not.toContain(name);
      expect(deferredToolNames()).toContain(name);
      expect(builtinHandlerNames.has(name)).toBe(true);
    }
  });

  it("keeps request-injected StructuredOutput out of the standard catalog", () => {
    expect(BASE_TOOL_NAMES).not.toContain("StructuredOutput");
    expect(deferredToolNames()).not.toContain("StructuredOutput");
    expect(registeredSchemaNames.has("StructuredOutput")).toBe(true);
    expect(builtinHandlerNames.has("StructuredOutput")).toBe(true);
  });

  it("exposes WaitForMcpServers only while an MCP server is pending", async () => {
    expect(deferredToolNames()).not.toContain("WaitForMcpServers");

    let resolveSpawn: ((client: McpClient) => void) | undefined;
    setMcpClientSpawnerForTests(
      () =>
        new Promise<McpClient>((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    const connection = clientFor("pending", {
      type: "stdio",
      command: "mcp-server",
      args: [],
    });
    expect(deferredToolNames()).toContain("WaitForMcpServers");

    expect(resolveSpawn).toBeDefined();
    resolveSpawn?.(CONNECTED_MCP_CLIENT);
    await connection;
    expect(deferredToolNames()).not.toContain("WaitForMcpServers");
  });

  it("every builtin handler has a registered schema", () => {
    const orphanHandlers = [...builtinHandlerNames].filter(
      (name) => !registeredSchemaNames.has(name),
    );
    expect(orphanHandlers).toEqual([]);
  });

  it("every catalog declaration has a handler or a justified scoped exception", () => {
    const undeclaredHandlers = [...catalogNames()].filter(
      (name) => !builtinHandlerNames.has(name) && !DECLARED_WITHOUT_BUILTIN_HANDLER.has(name),
    );
    expect(undeclaredHandlers).toEqual([]);
  });

  it("the scoped-exception list does not rot", () => {
    for (const name of DECLARED_WITHOUT_BUILTIN_HANDLER) {
      // still a real declaration…
      expect(catalogNames().has(name)).toBe(true);
      // …and still genuinely handler-less (else drop it from the exception list)
      expect(builtinHandlerNames.has(name)).toBe(false);
    }
  });
});
