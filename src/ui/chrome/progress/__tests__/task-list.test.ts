import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { TaskRecord, TaskStatus } from "@/engine/background/tasks/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  computeMaxTaskRows,
  findCurrentTask,
  findNextPendingTask,
  hiddenTaskSummary,
  isInternalTask,
  openBlockerIds,
  ownerBadge,
  RECENT_COMPLETED_TTL_MS,
  RecentCompletions,
  selectVisibleTasks,
  taskRowText,
} from "@/ui/chrome/progress/task-list.ts";

chalk.level = 3;

function task(id: string, status: TaskStatus, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    subject: `task ${id}`,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
    metadata: {},
    ...extra,
  };
}

const NO_RECENT: ReadonlySet<string> = new Set<string>();

describe("computeMaxTaskRows", () => {
  it("hides the list entirely on a viewport that cannot spare the rows", () => {
    expect(computeMaxTaskRows(10)).toBe(0);
    expect(computeMaxTaskRows(4)).toBe(0);
  });

  it("keeps a floor of three rows on a short-but-usable viewport", () => {
    expect(computeMaxTaskRows(11)).toBe(3);
    expect(computeMaxTaskRows(16)).toBe(3);
  });

  it("grows to the cap of ten as the viewport allows", () => {
    expect(computeMaxTaskRows(18)).toBe(4);
    expect(computeMaxTaskRows(19)).toBe(5);
    expect(computeMaxTaskRows(24)).toBe(10);
    expect(computeMaxTaskRows(120)).toBe(10);
  });
});

describe("selectVisibleTasks", () => {
  it("keeps stable id order while everything fits, whatever the statuses", () => {
    const tasks = [task("3", "completed"), task("1", "pending"), task("2", "in_progress")];
    const { visible, hidden } = selectVisibleTasks({
      tasks,
      maxDisplay: 5,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(hidden).toEqual({ inProgress: 0, pending: 0, completed: 0 });
  });

  it("never lets old completions push the in-progress task off the list", () => {
    const tasks = [
      task("1", "completed"),
      task("2", "completed"),
      task("3", "completed"),
      task("4", "completed"),
      task("5", "completed"),
      task("6", "in_progress"),
      task("7", "pending"),
    ];
    const { visible } = selectVisibleTasks({
      tasks,
      maxDisplay: 3,
      recentCompletedIds: NO_RECENT,
    });
    // Old completions sink: the live work and what comes next take the rows.
    expect(visible.map((t) => t.id)).toEqual(["6", "7", "1"]);
  });

  it("gives a just-finished task priority over an older one", () => {
    const tasks = [task("1", "completed"), task("2", "completed"), task("3", "pending")];
    const { visible } = selectVisibleTasks({
      tasks,
      maxDisplay: 2,
      recentCompletedIds: new Set(["2"]),
    });
    expect(visible.map((t) => t.id)).toEqual(["2", "3"]);
  });

  it("orders unblocked pending work ahead of blocked work", () => {
    const tasks = [
      task("1", "pending", { blockedBy: ["9"] }),
      task("2", "pending"),
      task("9", "in_progress"),
      task("3", "completed"),
    ];
    const { visible } = selectVisibleTasks({
      tasks,
      maxDisplay: 3,
      recentCompletedIds: NO_RECENT,
    });
    expect(visible.map((t) => t.id)).toEqual(["9", "2", "1"]);
  });

  it("counts what it hid, by status", () => {
    const tasks = [
      task("1", "in_progress"),
      task("2", "in_progress"),
      task("3", "pending"),
      task("4", "pending"),
      task("5", "completed"),
    ];
    const { hidden } = selectVisibleTasks({
      tasks,
      maxDisplay: 2,
      recentCompletedIds: NO_RECENT,
    });
    expect(hidden).toEqual({ inProgress: 0, pending: 2, completed: 1 });
  });
});

describe("hiddenTaskSummary", () => {
  it("names each status that has hidden work", () => {
    expect(hiddenTaskSummary({ inProgress: 1, pending: 2, completed: 3 })).toBe(
      "… +1 in progress, 2 pending, 3 completed",
    );
  });

  it("omits the statuses with nothing hidden", () => {
    expect(hiddenTaskSummary({ inProgress: 0, pending: 4, completed: 0 })).toBe("… +4 pending");
  });

  it("says nothing when everything is on screen", () => {
    expect(hiddenTaskSummary({ inProgress: 0, pending: 0, completed: 0 })).toBe("");
  });
});

describe("findNextPendingTask", () => {
  it("skips a pending task whose blocker is still open", () => {
    const tasks = [
      task("1", "pending", { blockedBy: ["3"] }),
      task("2", "pending"),
      task("3", "in_progress"),
    ];
    expect(findNextPendingTask(tasks)?.id).toBe("2");
  });

  it("treats a completed blocker as resolved", () => {
    const tasks = [task("1", "pending", { blockedBy: ["3"] }), task("3", "completed")];
    expect(findNextPendingTask(tasks)?.id).toBe("1");
  });

  it("falls back to the first pending task when all of them are blocked", () => {
    const tasks = [
      task("1", "pending", { blockedBy: ["9"] }),
      task("2", "pending", { blockedBy: ["9"] }),
      task("9", "in_progress"),
    ];
    expect(findNextPendingTask(tasks)?.id).toBe("1");
  });

  it("has nothing to offer when no task is pending", () => {
    expect(findNextPendingTask([task("1", "completed")])).toBeUndefined();
  });
});

describe("findCurrentTask", () => {
  it("picks the task being worked on, not a pending or finished one", () => {
    const tasks = [task("1", "completed"), task("2", "in_progress"), task("3", "pending")];
    expect(findCurrentTask(tasks)?.id).toBe("2");
  });

  it("has nothing to offer when nothing is in progress", () => {
    expect(findCurrentTask([task("1", "pending"), task("2", "completed")])).toBeUndefined();
  });
});

describe("ownerBadge", () => {
  const owners = new Set(["scout"]);

  it("names the owner while that agent is alive", () => {
    expect(
      ownerBadge({
        task: task("1", "in_progress", { owner: "scout" }),
        activeOwners: owners,
        columns: 100,
      }),
    ).toBe(" (@scout)");
  });

  it("stays silent for a claim whose agent has finished", () => {
    expect(
      ownerBadge({
        task: task("1", "in_progress", { owner: "ghost" }),
        activeOwners: owners,
        columns: 100,
      }),
    ).toBeNull();
  });

  it("gives up the columns on a narrow terminal", () => {
    expect(
      ownerBadge({
        task: task("1", "in_progress", { owner: "scout" }),
        activeOwners: owners,
        columns: 59,
      }),
    ).toBeNull();
  });

  it("stays silent for an unclaimed task", () => {
    expect(
      ownerBadge({ task: task("1", "pending"), activeOwners: owners, columns: 100 }),
    ).toBeNull();
  });
});

describe("taskRowText", () => {
  it("carries the owner badge and the open blockers", () => {
    const row = stripAnsi(
      taskRowText({
        task: task("1", "pending", { owner: "scout", blockedBy: ["2"] }),
        openBlockers: ["2"],
        activeOwners: new Set(["scout"]),
        columns: 100,
      }),
    );
    expect(row).toContain("task 1");
    expect(row).toContain("(@scout)");
    expect(row).toContain("blocked by #2");
  });

  it("elides a subject too long for the columns it has", () => {
    const row = stripAnsi(
      taskRowText({
        task: task("1", "pending", { subject: "x".repeat(200) }),
        openBlockers: [],
        activeOwners: new Set(),
        columns: 60,
      }),
    );
    expect(row).toContain("…");
    expect(row.length).toBeLessThan(80);
  });
});

describe("openBlockerIds", () => {
  it("reports only the blockers still open, in id order", () => {
    const unresolved = new Set(["10", "2"]);
    expect(
      openBlockerIds(task("1", "pending", { blockedBy: ["10", "2", "3"] }), unresolved),
    ).toEqual(["2", "10"]);
  });
});

describe("isInternalTask", () => {
  it("recognises the internal marker", () => {
    expect(isInternalTask(task("1", "pending", { metadata: { _internal: true } }))).toBe(true);
    expect(isInternalTask(task("1", "pending"))).toBe(false);
  });
});

describe("RecentCompletions", () => {
  it("does not treat tasks already finished on first sight as recent", () => {
    const tracker = new RecentCompletions();
    const tasks = [task("1", "completed")];
    tracker.observe(tasks, 1_000);
    expect(tracker.recentIds(1_000).size).toBe(0);
  });

  it("marks a completion it watched happen, until the window closes", () => {
    const tracker = new RecentCompletions();
    tracker.observe([task("1", "in_progress")], 1_000);
    tracker.observe([task("1", "completed")], 2_000);

    expect([...tracker.recentIds(2_000)]).toEqual(["1"]);
    expect([...tracker.recentIds(2_000 + RECENT_COMPLETED_TTL_MS - 1)]).toEqual(["1"]);
    expect(tracker.recentIds(2_000 + RECENT_COMPLETED_TTL_MS).size).toBe(0);
  });

  it("forgets a task that stopped being complete", () => {
    const tracker = new RecentCompletions();
    tracker.observe([task("1", "in_progress")], 1_000);
    tracker.observe([task("1", "completed")], 2_000);
    tracker.observe([task("1", "in_progress")], 3_000);
    expect(tracker.recentIds(3_000).size).toBe(0);
  });

  /**
   * Boards number their tasks independently, so recency must restart when the
   * observed board changes: without it, coming back from another board would
   * stamp every long-finished completion as fresh and parade it on top of the
   * truncated list while the live rows hide behind the counter.
   */
  it("does not resurrect a returning board's old completions as recent", () => {
    const tracker = new RecentCompletions();
    const mainBoard = [task("1", "completed"), task("2", "completed"), task("3", "in_progress")];
    tracker.observe(mainBoard, 1_000, "main:s1");
    // Peek at an agent's (empty) board, then come back.
    tracker.observe([], 2_000, "agent:fork_1");
    tracker.observe(mainBoard, 3_000, "main:s1");
    expect(tracker.recentIds(3_000).size).toBe(0);
  });

  it("does not carry recency stamped on one board into another with like ids", () => {
    const tracker = new RecentCompletions();
    tracker.observe([task("1", "in_progress")], 1_000, "main:s1");
    tracker.observe([task("1", "completed")], 2_000, "main:s1");
    expect([...tracker.recentIds(2_000)]).toEqual(["1"]);
    // A rebound session presents a different board under the same MAIN scope.
    tracker.observe([task("1", "completed")], 3_000, "main:s2");
    expect(tracker.recentIds(3_000).size).toBe(0);
  });

  it("keeps watching transitions after a board switch", () => {
    const tracker = new RecentCompletions();
    tracker.observe([task("1", "completed")], 1_000, "main:s1");
    tracker.observe([], 2_000, "agent:fork_1");
    tracker.observe([task("1", "completed"), task("2", "in_progress")], 3_000, "main:s1");
    tracker.observe([task("1", "completed"), task("2", "completed")], 4_000, "main:s1");
    expect([...tracker.recentIds(4_000)]).toEqual(["2"]);
  });
});
