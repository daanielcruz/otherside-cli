import { afterEach, describe, expect, test } from "bun:test";
import {
  appendAction,
  clear,
  get,
  list,
  setUsageSnapshot,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  aggregateSubtreeProgress,
  ensureChildTaskIdMap,
  resolveTaskIdForForkEvent,
  routeForkEventToTask,
} from "@/engine/background/tasks/progress.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

afterEach(() => {
  clear();
});

describe("aggregateSubtreeProgress", () => {
  test("sums tokens and tool uses across the full descendant tree", () => {
    const parent = startTask({
      parentToolCallId: "p0",
      agentName: "Parent",
      isBackgrounded: true,
    });
    const child = startTask({
      parentToolCallId: "c0",
      parentTaskId: parent.id,
      agentName: "Child",
      isBackgrounded: true,
    });
    const grandchild = startTask({
      parentToolCallId: "g0",
      parentTaskId: child.id,
      agentName: "Grandchild",
      isBackgrounded: true,
    });
    const sibling = startTask({
      parentToolCallId: "s0",
      agentName: "Sibling",
      isBackgrounded: true,
    });

    setUsageSnapshot(parent.id, { inputTokens: 100, outputTokens: 10 });
    setUsageSnapshot(child.id, { inputTokens: 200, outputTokens: 20 });
    setUsageSnapshot(grandchild.id, { inputTokens: 300, outputTokens: 30 });
    setUsageSnapshot(sibling.id, { inputTokens: 999, outputTokens: 9 });

    appendAction(parent.id, {
      id: "a1",
      toolName: "Agent",
      argsLabel: "spawn",
      running: false,
      ts: 1,
    });
    appendAction(child.id, {
      id: "a2",
      toolName: "Agent",
      argsLabel: "spawn",
      running: false,
      ts: 2,
    });
    appendAction(grandchild.id, {
      id: "a3",
      toolName: "Bash",
      argsLabel: "ls",
      running: true,
      ts: 3,
    });
    appendAction(grandchild.id, {
      id: "a4",
      toolName: "Read",
      argsLabel: "f",
      running: false,
      ts: 4,
    });

    const tasks = list();
    const progress = aggregateSubtreeProgress(parent.id, tasks);

    expect(progress.inputTokens).toBe(100 + 200 + 300);
    expect(progress.outputTokens).toBe(10 + 20 + 30);
    expect(progress.tokenCount).toBe(660);
    expect(progress.toolUses).toBe(4);

    const childOnly = aggregateSubtreeProgress(child.id, tasks);
    expect(childOnly.tokenCount).toBe(200 + 20 + 300 + 30);
    expect(childOnly.toolUses).toBe(3);

    const siblingOnly = aggregateSubtreeProgress(sibling.id, tasks);
    expect(siblingOnly.tokenCount).toBe(999 + 9);
    expect(siblingOnly.toolUses).toBe(0);
  });
});

describe("resolveTaskIdForForkEvent + routeForkEventToTask", () => {
  test("routes nested tool events onto the grandchild row via childTaskIdMap", () => {
    const parent = startTask({
      parentToolCallId: "p0",
      agentName: "Parent",
      isBackgrounded: true,
    });
    const grandchild = startTask({
      parentToolCallId: "tool-gc",
      parentTaskId: parent.id,
      agentName: "Grandchild",
      isBackgrounded: true,
    });
    const map = new Map<string, string>([["tool-gc", grandchild.id]]);

    const startEvent: ForkEvent = {
      kind: "fork_tool_dispatch_start",
      forkId: "f1",
      toolCallId: "t1",
      toolName: "Bash",
      input: { command: "echo hi" },
      parentToolCallId: "tool-gc",
    };
    const resolved = resolveTaskIdForForkEvent(startEvent, parent.id, map);
    expect(resolved).toBe(grandchild.id);
    routeForkEventToTask(resolved, startEvent);

    const usageEvent: ForkEvent = {
      kind: "fork_usage",
      forkId: "f1",
      inputTokens: 50,
      outputTokens: 5,
      parentToolCallId: "tool-gc",
    };
    routeForkEventToTask(resolveTaskIdForForkEvent(usageEvent, parent.id, map), usageEvent);

    const updated = get(grandchild.id);
    expect(updated?.actions).toHaveLength(1);
    expect(updated?.actions[0]?.toolName).toBe("Bash");
    expect(updated?.inputTokens).toBe(50);
    expect(updated?.outputTokens).toBe(5);

    const parentTask = get(parent.id);
    expect(parentTask?.actions).toHaveLength(0);
    expect(parentTask?.inputTokens).toBe(0);
  });

  test("falls back to the parent id when the map has no entry", () => {
    const event: ForkEvent = {
      kind: "fork_tool_dispatch_start",
      forkId: "f1",
      toolCallId: "t1",
      toolName: "Read",
      input: { file_path: "a.ts" },
      parentToolCallId: "missing",
    };
    expect(resolveTaskIdForForkEvent(event, "parent-id", new Map())).toBe("parent-id");
    expect(resolveTaskIdForForkEvent(event, "parent-id", undefined)).toBe("parent-id");
  });
});

describe("ensureChildTaskIdMap", () => {
  test("creates a map on ctx when missing and reuses it on later calls", () => {
    const ctx = {} as RequestContext;
    const first = ensureChildTaskIdMap(ctx);
    first.set("a", "b");
    const second = ensureChildTaskIdMap(ctx);
    expect(second).toBe(first);
    expect(second.get("a")).toBe("b");
  });
});
