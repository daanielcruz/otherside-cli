import { describe, expect, it } from "bun:test";
import { isForkDisallowedTool } from "../fork-disallowed.ts";

describe("isForkDisallowedTool", () => {
  it("denies the interactive set for forks", () => {
    for (const name of ["AskUserQuestion", "ScheduleWakeup", "WaitForMcpServers", "Workflow"]) {
      expect(isForkDisallowedTool(name)).toBe(true);
    }
    expect(isForkDisallowedTool("Read")).toBe(false);
  });
});
