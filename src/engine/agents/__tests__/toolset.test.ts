import { describe, expect, it } from "bun:test";
import { MAX_AGENT_SPAWN_DEPTH } from "../agent-context.ts";
import { ASYNC_AGENT_ALLOWED_TOOLS, filterToolsForAgent } from "../toolset.ts";

const BASE = {
  isAsync: true,
  isBuiltInAgent: true,
  spawnDepth: 0,
  kind: "subagent" as const,
};

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

  it("Agent stays declared below the spawn ceiling", () => {
    expect(filterToolsForAgent(["Agent"], BASE)).toEqual(["Agent"]);
    expect(filterToolsForAgent(["Agent"], { ...BASE, spawnDepth: MAX_AGENT_SPAWN_DEPTH })).toEqual([
      "Agent",
    ]);
  });
});
