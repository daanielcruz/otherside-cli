import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  cancelTaskTree,
  clear,
  completeTaskForRun,
  detachTaskForRun,
  get,
  markOwnerNotificationsConsumed,
  markOwnerNotificationsPromoted,
  reopenTask,
  resetEmitThrottleForTests,
  setEvictionDelayForTests,
  startTask,
  stopTaskForUser,
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

function registerForkOwner(ownerId: string) {
  return emitQueue.registerOwner(ownerId, {
    onInventoryConsumed: (replayKeys) => markOwnerNotificationsConsumed(ownerId, replayKeys),
    onOwnerRelease: ({ promotedReplayKeys }) =>
      markOwnerNotificationsPromoted(ownerId, promotedReplayKeys),
  });
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

describe("nested agent lifecycle behavior", () => {
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

  test("a user-initiated kill stops detached descendants instead of reparenting them", () => {
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

    // The user kill takes the whole tree: the detached child is stopped with
    // the root, silenced, and never reparented to keep running under main.
    expect(stopTaskForUser(parent)).toBe(true);
    expect(get(parent.id)?.status).toBe("killed");
    expect(get(parent.id)?.stoppedByUser).toBe(true);
    expect(get(child.id)?.status).toBe("killed");
    expect(childAbort.signal.aborted).toBe(true);
    expect(notifications(child.id)).toHaveLength(0);
    releaseOwner();
  });

  test("terminal child rows evict independently while the owner remains active", async () => {
    setEvictionDelayForTests(5);
    const cases = [
      { label: "completed", result: { content: "finished", isError: false } },
      { label: "error", result: { content: "failed", isError: true } },
      {
        label: "killed",
        result: { content: "stopped", isError: false, killed: true, userInitiated: true },
      },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const ownerId = `parent-fork-${index}`;
      const releaseOwner = registerForkOwner(ownerId);
      const parent = agent({ callId: `parent-${scenario.label}` });
      const child = agent({
        callId: `child-${scenario.label}`,
        parentTaskId: parent.id,
        ownerId,
        mode: "detached",
      });

      expect(completeTaskForRun(taskRunRef(child), scenario.result)).toBe(true);
      expect(get(child.id)?.terminalNotification).toBe("owner");
      expect(notifications(child.id)[0]?.target).toBe("inventory");
      await Bun.sleep(15);
      expect(get(child.id), scenario.label).toBeUndefined();
      expect(get(parent.id)?.status).toBe("running");

      releaseOwner();
      expect(get(child.id)).toBeUndefined();
      expect(notifications(child.id)[0]?.target).toBe("both");
      expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);
      expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
      expect(
        cancelTaskTree(taskRunRef(parent), {
          reason: "parent cancelled",
          suppressRootNotification: true,
        }),
      ).toBe(true);
      expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
    }
  });

  test("consumed child notification never replays after cancellation and owner exit", async () => {
    setEvictionDelayForTests(5);
    const ownerId = "parent-fork-consumed";
    const releaseOwner = registerForkOwner(ownerId);
    const parent = agent({ callId: "parent-consumed" });
    const child = agent({
      callId: "child-consumed",
      parentTaskId: parent.id,
      ownerId,
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner(ownerId)).toHaveLength(1);
    expect(get(child.id)?.terminalNotification).toBe("parent");
    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(get(child.id)?.terminalNotification).toBe("parent");

    releaseOwner();
    expect(notifications(child.id)).toHaveLength(0);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
    await Bun.sleep(15);
    expect(get(child.id)).toBeUndefined();
  });

  test("unread terminal child notification promotes to main once on owner exit", async () => {
    setEvictionDelayForTests(5);
    const ownerId = "parent-fork-unread";
    const releaseOwner = registerForkOwner(ownerId);
    const parent = agent({ callId: "parent-unread" });
    const child = agent({
      callId: "child-unread",
      parentTaskId: parent.id,
      ownerId,
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(child), { content: "finished", isError: false })).toBe(
      true,
    );
    expect(get(child.id)?.terminalNotification).toBe("owner");
    expect(notifications(child.id)[0]?.target).toBe("inventory");
    expect(
      cancelTaskTree(taskRunRef(parent), {
        reason: "parent cancelled",
        suppressRootNotification: true,
      }),
    ).toBe(true);
    expect(get(child.id)?.terminalNotification).toBe("owner");
    expect(get(parent.id)?.status).toBe("killed");

    releaseOwner();
    expect(get(child.id)?.terminalNotification).toBe("main");
    expect(notifications(child.id)[0]?.target).toBe("both");
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
    await Bun.sleep(15);
    expect(get(child.id)).toBeUndefined();
  });

  test("three-level notifications stop at the immediate owner", () => {
    const releaseRootOwner = registerForkOwner("root-fork");
    const releaseChildOwner = registerForkOwner("child-fork");
    const root = agent({ callId: "root" });
    const child = agent({ callId: "child", parentTaskId: root.id, ownerId: "root-fork" });
    const grandchild = agent({
      callId: "grandchild",
      parentTaskId: child.id,
      ownerId: "child-fork",
      mode: "detached",
    });

    expect(completeTaskForRun(taskRunRef(grandchild), { content: "done", isError: false })).toBe(
      true,
    );
    expect(emitQueue.takeForOwner("child-fork")).toHaveLength(1);
    expect(get(grandchild.id)?.terminalNotification).toBe("parent");
    expect(emitQueue.takeForOwner("root-fork")).toHaveLength(0);
    releaseChildOwner();
    releaseRootOwner();
    expect(notifications(grandchild.id)).toHaveLength(0);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);

    const unreadRootOwner = registerForkOwner("root-fork-unread");
    const unreadChildOwner = registerForkOwner("child-fork-unread");
    const unreadRoot = agent({ callId: "root-unread" });
    const unreadChild = agent({
      callId: "child-unread",
      parentTaskId: unreadRoot.id,
      ownerId: "root-fork-unread",
    });
    const unreadGrandchild = agent({
      callId: "grandchild-unread",
      parentTaskId: unreadChild.id,
      ownerId: "child-fork-unread",
      mode: "detached",
    });

    expect(
      completeTaskForRun(taskRunRef(unreadGrandchild), { content: "unread", isError: false }),
    ).toBe(true);
    expect(notifications(unreadGrandchild.id)[0]?.target).toBe("inventory");
    unreadChildOwner();
    expect(get(unreadGrandchild.id)?.terminalNotification).toBe("main");
    expect(notifications(unreadGrandchild.id)[0]?.target).toBe("both");
    expect(emitQueue.takeForOwner("root-fork-unread")).toHaveLength(0);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(1);
    expect(emitQueue.drainForBoundary("turn_start").notificationTexts).toHaveLength(0);
    unreadRootOwner();
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
