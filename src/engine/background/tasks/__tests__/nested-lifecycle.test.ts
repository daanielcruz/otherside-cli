import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  cancelTaskTree,
  clear,
  completeTaskForRun,
  detachTaskForRun,
  get,
  markOwnerNotificationsPromoted,
  removeTask,
  reopenTask,
  resetEmitThrottleForTests,
  setEvictionDelayForTests,
  startTask,
  taskRunRef,
} from "../background.ts";
import * as controllers from "../background-controllers.ts";

const DEFAULT_EVICTION_DELAY_MS = 30_000;

function agent(input: {
  callId: string;
  parentTaskId?: string;
  ownerId?: string;
  mode?: "linked" | "detached";
}) {
  return startTask({
    parentToolCallId: input.callId,
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
    lifecycleMode: input.mode ?? "linked",
    isBackgrounded: true,
    agentName: input.callId,
  });
}

function notifications(taskId: string) {
  return emitQueue.peek().filter((item) => item.replayKey?.startsWith(`bg:${taskId}:`));
}

beforeEach(() => {
  clear();
  resetEmitThrottleForTests();
  controllers._resetForTests();
  emitQueue._resetForTests();
});

afterEach(() => {
  clear();
  resetEmitThrottleForTests();
  setEvictionDelayForTests(DEFAULT_EVICTION_DELAY_MS);
  controllers._resetForTests();
  emitQueue._resetForTests();
});

describe("nested agent lifecycle parity", () => {
  test("parent cancellation aborts a running linked child without a main notification", () => {
    const parent = agent({ callId: "parent" });
    const child = agent({ callId: "child", parentTaskId: parent.id, ownerId: "parent-fork" });
    const childAbort = new AbortController();
    let aborts = 0;
    controllers.register(child.parentToolCallId, {
      taskId: child.id,
      signal: () => {},
      isBackgrounded: () => false,
      abort: () => {
        aborts += 1;
        childAbort.abort();
      },
    });

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);

    expect(get(child.id)?.status).toBe("killed");
    expect(get(child.id)?.terminalNotification).toBe("discarded");
    expect(childAbort.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
    expect(notifications(child.id)).toHaveLength(0);
  });

  test("completion immediately before or after parent cancellation never leaks to main", () => {
    const beforeParent = agent({ callId: "before-parent" });
    const beforeChild = agent({
      callId: "before-child",
      parentTaskId: beforeParent.id,
      ownerId: "before-fork",
    });
    const beforeRun = taskRunRef(beforeChild);
    expect(completeTaskForRun(beforeRun, { content: "done", isError: false })).toBe(true);
    cancelTaskTree(taskRunRef(beforeParent), {
      reason: "parent cancelled",
      suppressRootNotification: true,
    });
    expect(get(beforeChild.id)?.status).toBe("completed");
    expect(get(beforeChild.id)?.terminalNotification).toBe("parent");
    expect(notifications(beforeChild.id)).toHaveLength(0);

    const afterParent = agent({ callId: "after-parent" });
    const afterChild = agent({
      callId: "after-child",
      parentTaskId: afterParent.id,
      ownerId: "after-fork",
    });
    const afterRun = taskRunRef(afterChild);
    cancelTaskTree(taskRunRef(afterParent), {
      reason: "parent cancelled",
      suppressRootNotification: true,
    });
    expect(completeTaskForRun(afterRun, { content: "late", isError: false })).toBe(false);
    expect(get(afterChild.id)?.status).toBe("killed");
    expect(get(afterChild.id)?.terminalNotification).toBe("discarded");
    expect(notifications(afterChild.id)).toHaveLength(0);
  });

  test("an explicitly detached child survives, reparents, and notifies main once", () => {
    const releaseOwner = emitQueue.registerOwner("parent-fork");
    const parent = agent({ callId: "parent" });
    const child = agent({ callId: "child", parentTaskId: parent.id, ownerId: "parent-fork" });
    const childRun = taskRunRef(child);
    const childAbort = new AbortController();
    controllers.register(child.parentToolCallId, {
      taskId: child.id,
      signal: () => {},
      isBackgrounded: () => true,
      abort: () => childAbort.abort(),
    });
    expect(detachTaskForRun(childRun)).toBe(true);

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(get(child.id)?.status).toBe("running");
    expect(get(child.id)?.ownerId).toBeUndefined();
    expect(get(child.id)?.reparentedGeneration).toBe(childRun.generation);
    expect(childAbort.signal.aborted).toBe(false);

    expect(completeTaskForRun(childRun, { content: "survived", isError: false })).toBe(true);
    expect(completeTaskForRun(childRun, { content: "duplicate", isError: false })).toBe(false);
    const [notice] = notifications(child.id);
    expect(notifications(child.id)).toHaveLength(1);
    expect(notice?.target).toBe("both");
    expect(notice?.ownerId).toBeUndefined();
    releaseOwner();
  });

  test("re-emits a detached completion consumed before owner cancellation exactly once", () => {
    const releaseOwner = emitQueue.registerOwner("parent-fork");
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });
    const childRun = taskRunRef(child);

    expect(completeTaskForRun(childRun, { content: "finished", isError: false })).toBe(true);
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1);
    expect(notifications(child.id)).toHaveLength(0);

    for (let index = 0; index < 1_024; index++) {
      emitQueue.emitForCompletion({
        class: "deferred_output",
        ownerId: "parent-fork",
        isSubagentOwned: true,
        payload: { kind: "task_notification_xml", text: `<churn>${index}</churn>` },
        replayKey: `churn:${index}`,
      });
    }
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1_024);
    expect(emitQueue.wasReplayKeyConsumed(`bg:${child.id}:${childRun.generation}`)).toBe(false);
    releaseOwner();
    expect(get(child.id)?.terminalNotification).toBe("owner");

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(get(child.id)?.status).toBe("completed");
    expect(get(child.id)?.ownerId).toBeUndefined();
    expect(get(child.id)?.terminalNotification).toBe("main");
    expect(notifications(child.id)).toHaveLength(1);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled again",
        suppressRootNotification: true,
      }),
    ).toBe(false);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
  });

  test("does not replay a detached completion promoted when its owner exits", async () => {
    setEvictionDelayForTests(5);
    const releaseOwner = emitQueue.registerOwner("parent-fork", (replayKeys) =>
      markOwnerNotificationsPromoted("parent-fork", replayKeys),
    );
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(get(child.id)?.terminalNotification).toBe("owner");
    expect(notifications(child.id)[0]?.target).toBe("inventory");

    releaseOwner();
    expect(get(child.id)?.terminalNotification).toBe("main");
    expect(notifications(child.id)[0]?.target).toBe("both");
    await Bun.sleep(15);
    expect(get(child.id)).toBeUndefined();
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
  });

  test("retains an owner-consumed completion until delayed parent cancellation", async () => {
    setEvictionDelayForTests(5);
    const releaseOwner = emitQueue.registerOwner("parent-fork", (replayKeys) =>
      markOwnerNotificationsPromoted("parent-fork", replayKeys),
    );
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1);
    releaseOwner();
    await Bun.sleep(15);
    expect(get(child.id)?.terminalNotification).toBe("owner");

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(get(child.id)).toBeUndefined();
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);
  });

  test("releases owner-consumed retention when the parent finishes", async () => {
    setEvictionDelayForTests(5);
    const releaseOwner = emitQueue.registerOwner("parent-fork", (replayKeys) =>
      markOwnerNotificationsPromoted("parent-fork", replayKeys),
    );
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1);
    releaseOwner();
    await Bun.sleep(15);
    expect(get(child.id)).toBeDefined();

    expect(completeTaskForRun(taskRunRef(parent), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(get(child.id)).toBeUndefined();
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
  });

  test("does not retain a child that completes after its parent finishes", async () => {
    setEvictionDelayForTests(5);
    const releaseOwner = emitQueue.registerOwner("parent-fork", (replayKeys) =>
      markOwnerNotificationsPromoted("parent-fork", replayKeys),
    );
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(parent), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1);
    releaseOwner();
    await Bun.sleep(15);
    expect(get(child.id)).toBeUndefined();
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
  });

  test("releases owner-consumed retention when the parent is removed", async () => {
    setEvictionDelayForTests(5);
    const releaseOwner = emitQueue.registerOwner("parent-fork", (replayKeys) =>
      markOwnerNotificationsPromoted("parent-fork", replayKeys),
    );
    const parent = agent({ callId: "parent" });
    const child = agent({
      callId: "child",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner("parent-fork")).toHaveLength(1);
    releaseOwner();
    await Bun.sleep(15);
    expect(get(child.id)).toBeDefined();

    expect(removeTask(parent.id)).toBe(true);
    expect(get(child.id)).toBeUndefined();
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
  });

  test("repeated cascading cancellation is idempotent across descendants and generations", () => {
    const parent = agent({ callId: "p" });
    const child = agent({ callId: "c", parentTaskId: parent.id, ownerId: "p-fork" });
    const grandchild = agent({ callId: "g", parentTaskId: child.id, ownerId: "c-fork" });
    const detached = agent({ callId: "d", parentTaskId: child.id, ownerId: "c-fork" });
    detachTaskForRun(taskRunRef(detached));
    const counts = new Map<string, number>();
    for (const task of [child, grandchild, detached]) {
      controllers.register(task.parentToolCallId, {
        taskId: task.id,
        signal: () => {},
        isBackgrounded: () => task.id === detached.id,
        abort: () => counts.set(task.id, (counts.get(task.id) ?? 0) + 1),
      });
    }
    const oldChildRun = taskRunRef(child);

    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "stop",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "stop again",
        suppressRootNotification: true,
      }),
    ).toBe(false);
    expect(get(child.id)?.status).toBe("killed");
    expect(get(grandchild.id)?.status).toBe("killed");
    expect(get(detached.id)?.status).toBe("running");
    expect(counts.get(child.id)).toBe(1);
    expect(counts.get(grandchild.id)).toBe(1);
    expect(counts.get(detached.id)).toBeUndefined();

    const reopened = reopenTask(child.id);
    expect(reopened?.runGeneration).toBe(1);
    expect(reopened?.lifecycleMode).toBe("detached");
    expect(completeTaskForRun(oldChildRun, { content: "stale", isError: false })).toBe(false);
    expect(get(child.id)?.status).toBe("running");
  });

  test("a stale controller release cannot unregister a resumed generation", () => {
    const oldController = { signal: () => {}, isBackgrounded: () => true };
    const nextController = { signal: () => {}, isBackgrounded: () => true };
    const releaseOld = controllers.register("same-call", oldController);
    const releaseNext = controllers.register("same-call", nextController);

    releaseOld();
    releaseOld();
    expect(controllers.get("same-call")).toBe(nextController);
    controllers.unregister("same-call", oldController);
    expect(controllers.get("same-call")).toBe(nextController);
    releaseNext();
    expect(controllers.get("same-call")).toBeUndefined();
  });

  test("resumed generations remain detached and reject stale completion", () => {
    const task = agent({ callId: "resume" });
    const firstRun = taskRunRef(task);
    completeTaskForRun(firstRun, { content: "first", isError: false });
    const resumed = reopenTask(task.id);
    expect(resumed).toBeDefined();
    const resumedRun = taskRunRef(resumed!);
    expect(resumed?.lifecycleMode).toBe("detached");
    expect(resumedRun.token).not.toBe(firstRun.token);
    expect(completeTaskForRun(firstRun, { content: "stale", isError: false })).toBe(false);
    expect(completeTaskForRun(resumedRun, { content: "second", isError: false })).toBe(true);
    expect(notifications(task.id)).toHaveLength(1);
    expect(notifications(task.id)[0]?.target).toBe("both");
  });
});
