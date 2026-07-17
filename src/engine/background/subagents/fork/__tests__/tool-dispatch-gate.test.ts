import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  activeDeferredToolNames,
  announceDeferredTool,
  clearDeferredAnnouncements,
  clearDeferredAnnouncementsForScope,
} from "@/engine/tools/deferred.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import { isDispatchableForkTool } from "../tool-dispatch.ts";

const AGENT_SCOPE = "agent-gate-test-1";
const OTHER_AGENT_SCOPE = "agent-gate-test-2";

beforeAll(() => {
  registerAllBuiltins();
});

afterEach(() => {
  clearDeferredAnnouncements();
});

describe("deferred announcements are scoped per agent", () => {
  test("a main-session announcement never appears in an agent scope", () => {
    announceDeferredTool("TaskList");
    expect(activeDeferredToolNames()).toContain("TaskList");
    expect(activeDeferredToolNames(AGENT_SCOPE)).not.toContain("TaskList");
  });

  test("an agent announcement stays in its own scope", () => {
    announceDeferredTool("NotebookEdit", AGENT_SCOPE);
    expect(activeDeferredToolNames(AGENT_SCOPE)).toContain("NotebookEdit");
    expect(activeDeferredToolNames()).not.toContain("NotebookEdit");
    expect(activeDeferredToolNames(OTHER_AGENT_SCOPE)).not.toContain("NotebookEdit");
  });

  test("scope teardown drops only the finished agent's announcements", () => {
    announceDeferredTool("TaskList");
    announceDeferredTool("NotebookEdit", AGENT_SCOPE);
    clearDeferredAnnouncementsForScope(AGENT_SCOPE);
    expect(activeDeferredToolNames(AGENT_SCOPE)).toEqual([]);
    expect(activeDeferredToolNames()).toContain("TaskList");
  });
});

describe("fork dispatch gate honors only the agent's own ToolSearch loads", () => {
  const allowSet = new Set(["Bash", "Read", "ToolSearch", "TaskStop"]);

  test("a tool announced by the main session stays denied for the agent", () => {
    // Main loaded the planning task tools; the agent's allow set has no
    // TaskList and the agent itself never ran ToolSearch for it.
    announceDeferredTool("TaskList");
    expect(isDispatchableForkTool("TaskList", allowSet, { ownerScope: AGENT_SCOPE })).toBe(false);
  });

  test("the same tool becomes dispatchable after the agent's own load", () => {
    announceDeferredTool("TaskList", AGENT_SCOPE);
    expect(isDispatchableForkTool("TaskList", allowSet, { ownerScope: AGENT_SCOPE })).toBe(true);
  });

  test("another agent's load never grants dispatch", () => {
    announceDeferredTool("TaskList", OTHER_AGENT_SCOPE);
    expect(isDispatchableForkTool("TaskList", allowSet, { ownerScope: AGENT_SCOPE })).toBe(false);
  });

  test("without ToolSearch in the allow set even an own load grants nothing", () => {
    const noSearch = new Set(["Bash", "Read"]);
    announceDeferredTool("TaskList", AGENT_SCOPE);
    expect(isDispatchableForkTool("TaskList", noSearch, { ownerScope: AGENT_SCOPE })).toBe(false);
  });

  test("allow-set membership and the null allow set keep working", () => {
    expect(isDispatchableForkTool("Bash", allowSet, { ownerScope: AGENT_SCOPE })).toBe(true);
    expect(isDispatchableForkTool("TaskList", null, { ownerScope: AGENT_SCOPE })).toBe(true);
  });

  test("fork-disallowed tools stay denied regardless of loads", () => {
    announceDeferredTool("ScheduleWakeup", AGENT_SCOPE);
    expect(isDispatchableForkTool("ScheduleWakeup", allowSet, { ownerScope: AGENT_SCOPE })).toBe(
      false,
    );
  });
});
