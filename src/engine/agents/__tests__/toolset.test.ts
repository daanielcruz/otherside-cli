import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { MAX_AGENT_SPAWN_DEPTH } from "../agent-context.ts";
import { ASYNC_AGENT_ALLOWED_TOOLS, filterToolsForAgent, resolveToolsetFor } from "../toolset.ts";

const BASE = {
  isAsync: true,
  isBuiltInAgent: true,
  spawnDepth: 0,
  kind: "subagent" as const,
};

beforeAll(() => {
  registerAllBuiltins();
});

describe("filterToolsForAgent", () => {
  it("async allowlist keeps ToolSearch, Skill, and SendMessage and never AskUserQuestion", () => {
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("ToolSearch")).toBe(true);
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("Skill")).toBe(true);
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("SendMessage")).toBe(true);
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("AskUserQuestion")).toBe(false);
    const out = filterToolsForAgent(
      ["ToolSearch", "Skill", "SendMessage", "AskUserQuestion"],
      BASE,
    );
    expect(out).toEqual(["ToolSearch", "Skill", "SendMessage"]);
  });

  it("async allowlist carries the worktree pair and drops WaitForMcpServers everywhere", () => {
    const out = filterToolsForAgent(["EnterWorktree", "ExitWorktree", "WaitForMcpServers"], BASE);
    expect(out).toEqual(["EnterWorktree", "ExitWorktree"]);
    expect(filterToolsForAgent(["WaitForMcpServers"], { ...BASE, isAsync: false })).toEqual([]);
  });

  it("mcp tools bypass every check", () => {
    const out = filterToolsForAgent(["mcp__srv__thing", "EnterPlanMode"], BASE);
    expect(out).toEqual(["mcp__srv__thing"]);
  });

  it("ExitPlanMode survives only for plan-mode agents", () => {
    expect(filterToolsForAgent(["ExitPlanMode"], BASE)).toEqual([]);
    expect(filterToolsForAgent(["ExitPlanMode"], { ...BASE, permissionMode: "plan" })).toEqual([
      "ExitPlanMode",
    ]);
  });

  it("plan-mode agents gain ExitPlanMode even when the pool never offered it", () => {
    expect(filterToolsForAgent(["Read"], { ...BASE, permissionMode: "plan" })).toEqual([
      "Read",
      "ExitPlanMode",
    ]);
    expect(filterToolsForAgent(["Read"], BASE)).toEqual(["Read"]);
  });

  it("custom (non-built-in) agent definitions lose Workflow", () => {
    expect(filterToolsForAgent(["Workflow"], BASE)).toEqual([]);
    expect(filterToolsForAgent(["Workflow"], { ...BASE, isBuiltInAgent: false })).toEqual([]);
    // Workflow sits in ALL_AGENT_DISALLOWED_TOOLS, so every agent kind loses
    // it regardless of async or built-in status.
    expect(filterToolsForAgent(["Workflow"], { ...BASE, isAsync: false })).toEqual([]);
    expect(
      filterToolsForAgent(["Workflow"], { ...BASE, isAsync: false, isBuiltInAgent: false }),
    ).toEqual([]);
  });

  it("Agent rides the spawn-depth rule for every non-main kind", () => {
    expect(filterToolsForAgent(["Agent"], BASE)).toEqual(["Agent"]);
    expect(filterToolsForAgent(["Agent"], { ...BASE, spawnDepth: MAX_AGENT_SPAWN_DEPTH })).toEqual(
      [],
    );
    expect(filterToolsForAgent(["Agent"], { ...BASE, isAsync: false })).toEqual(["Agent"]);
    expect(
      filterToolsForAgent(["Agent"], {
        ...BASE,
        isAsync: false,
        spawnDepth: MAX_AGENT_SPAWN_DEPTH,
      }),
    ).toEqual([]);
  });
});

describe("resolveToolsetFor", () => {
  const ctx = {
    isBuiltIn: () => true,
    isBuiltInAgent: true,
    spawnDepth: 0,
  };

  it("keeps planning tasks out of ordinary async agents", () => {
    const tools = resolveToolsetFor("subagent", ctx);

    expect(tools).toContain("TaskStop");
    expect(tools).not.toContain("TaskCreate");
    expect(tools).not.toContain("TaskGet");
    expect(tools).not.toContain("TaskList");
    expect(tools).not.toContain("TaskUpdate");
  });

  it("gives workflow workers the synchronous pool: planning tasks in, Agent and TaskOutput out", () => {
    const tools = resolveToolsetFor("workflow", ctx);

    expect(tools).toContain("TaskCreate");
    expect(tools).toContain("TaskGet");
    expect(tools).toContain("TaskList");
    expect(tools).toContain("TaskStop");
    expect(tools).toContain("TaskUpdate");
    // Synchronous filter: tools outside the async allowlist survive too.
    expect(tools).toContain("CronCreate");
    expect(tools).not.toContain("TaskOutput");
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("Workflow");
    expect(tools).not.toContain("AskUserQuestion");
  });
});
