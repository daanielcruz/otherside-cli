import { describe, expect, it } from "bun:test";
import type { TaskRecord } from "@/engine/background/tasks/index.ts";
import { openBlockerIds, selectVisibleTasks } from "../blocks/task-list-inline.tsx";

function task(id: string, status: TaskRecord["status"]): TaskRecord {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
    metadata: {},
  };
}

const NO_RECENT: ReadonlySet<string> = new Set();

describe("selectVisibleTasks display window", () => {
  it("keeps ascending ID order when everything fits, regardless of status", () => {
    const { visible, hidden } = selectVisibleTasks({
      tasks: [task("3", "completed"), task("1", "completed"), task("2", "pending")],
      maxDisplay: 6,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(hidden).toEqual({ inProgress: 0, pending: 0, completed: 0 });
  });

  it("prioritizes in-progress and pending over older completed under pressure", () => {
    const tasks = [
      task("1", "completed"),
      task("2", "completed"),
      task("3", "pending"),
      task("4", "in_progress"),
    ];
    const { visible, hidden } = selectVisibleTasks({
      tasks,
      maxDisplay: 3,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["4", "3", "1"]);
    expect(hidden.completed).toBe(1);
  });

  it("recently completed rows displace active ones under pressure", () => {
    const tasks = [
      task("1", "completed"),
      task("2", "in_progress"),
      task("3", "pending"),
      task("4", "completed"),
    ];
    const { visible, hidden } = selectVisibleTasks({
      tasks,
      maxDisplay: 2,
      recentCompletedIds: new Set(["4"]),
    });
    expect(visible.map((t) => t.id)).toEqual(["4", "2"]);
    expect(hidden).toEqual({ inProgress: 0, pending: 1, completed: 1 });
  });

  it("counts every hidden task in the overflow by class", () => {
    const tasks = [
      task("1", "in_progress"),
      task("2", "in_progress"),
      task("3", "pending"),
      task("4", "completed"),
      task("5", "completed"),
    ];
    const { visible, hidden } = selectVisibleTasks({
      tasks,
      maxDisplay: 2,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["1", "2"]);
    expect(hidden).toEqual({ inProgress: 0, pending: 1, completed: 2 });
  });

  it("orders blocked pending tasks after unblocked ones under pressure", () => {
    const blocked = { ...task("1", "pending"), blockedBy: ["3"] };
    const tasks = [blocked, task("2", "pending"), task("3", "in_progress"), task("4", "pending")];
    const { visible } = selectVisibleTasks({
      tasks,
      maxDisplay: 3,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["3", "2", "4"]);
  });

  it("returns clean zeros for an empty list", () => {
    const { visible, hidden } = selectVisibleTasks({
      tasks: [],
      maxDisplay: 6,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible).toEqual([]);
    expect(hidden).toEqual({ inProgress: 0, pending: 0, completed: 0 });
  });
});

describe("openBlockerIds", () => {
  it("returns only unresolved blockers, sorted by id", () => {
    const blocked = { ...task("5", "pending"), blockedBy: ["10", "2", "3"] };
    const unresolved = new Set(["10", "2", "5"]);
    expect(openBlockerIds(blocked, unresolved)).toEqual(["2", "10"]);
  });

  it("returns empty when every blocker is resolved", () => {
    const blocked = { ...task("5", "pending"), blockedBy: ["1"] };
    expect(openBlockerIds(blocked, new Set(["5"]))).toEqual([]);
  });
});
