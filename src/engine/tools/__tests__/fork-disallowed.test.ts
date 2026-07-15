import { describe, expect, it } from "bun:test";
import { isForkDisallowedTool } from "../fork-disallowed.ts";

describe("isForkDisallowedTool", () => {
  it("denies the interactive/plan set for forks by default", () => {
    for (const name of [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "WaitForMcpServers",
      "Workflow",
    ]) {
      expect(isForkDisallowedTool(name)).toBe(true);
    }
    expect(isForkDisallowedTool("Read")).toBe(false);
  });

  it("lifts only ExitPlanMode under a plan-pinned definition", () => {
    expect(isForkDisallowedTool("ExitPlanMode", "plan")).toBe(false);
    expect(isForkDisallowedTool("EnterPlanMode", "plan")).toBe(true);
    expect(isForkDisallowedTool("AskUserQuestion", "plan")).toBe(true);
    expect(isForkDisallowedTool("ExitPlanMode", "default")).toBe(true);
    expect(isForkDisallowedTool("ExitPlanMode", "yolo")).toBe(true);
  });
});
