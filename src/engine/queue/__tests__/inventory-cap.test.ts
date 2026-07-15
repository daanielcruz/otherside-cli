import { beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";

beforeEach(() => {
  emitQueue._resetForTests();
});

describe("owner inventory retention", () => {
  test("retains every completion while its owner is active", () => {
    const releases: Array<() => void> = [];
    for (let i = 0; i < 600; i += 1) {
      const ownerId = `owner${i}`;
      releases.push(emitQueue.registerOwner(ownerId));
      emitQueue.emitForCompletion({
        class: "deferred_output",
        ownerId,
        isSubagentOwned: true,
        payload: { kind: "tool_result", toolUseId: `a${i}`, content: "x" },
      });
    }

    const items = emitQueue.peek({ class: "deferred_output" });
    expect(items).toHaveLength(600);
    expect(items.every((item) => item.target === "inventory")).toBe(true);
    for (const release of releases) release();
  });

  test("reroutes queued inventory to main when its owner exits", () => {
    const release = emitQueue.registerOwner("owner1");
    emitQueue.emitForCompletion({
      class: "urgent_output",
      ownerId: "owner1",
      isSubagentOwned: true,
      payload: { kind: "tool_result", toolUseId: "nested", content: "x" },
    });

    release();

    const [item] = emitQueue.peek({ class: "urgent_output" });
    expect(item?.target).toBe("both");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("routes a late completion directly to main after owner exit", () => {
    const release = emitQueue.registerOwner("owner1");
    release();
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "owner1",
      isSubagentOwned: true,
      payload: { kind: "tool_result", toolUseId: "late", content: "x" },
    });

    const [item] = emitQueue.peek({ class: "deferred_output" });
    expect(item?.target).toBe("both");
  });

  test("lease refcounting retains inventory until last release", () => {
    const release1 = emitQueue.registerOwner("owner2");
    const release2 = emitQueue.registerOwner("owner2");

    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "owner2",
      isSubagentOwned: true,
      payload: { kind: "tool_result", toolUseId: "task1", content: "x" },
    });

    // Both leases active, routes to inventory
    let items = emitQueue.peek({ class: "deferred_output", ownerId: "owner2" });
    expect(items).toHaveLength(1);
    expect(items[0]?.target).toBe("inventory");

    // Releasing first lease must keep existing item inventory
    release1();
    items = emitQueue.peek({ class: "deferred_output", ownerId: "owner2" });
    expect(items[0]?.target).toBe("inventory");

    // A late completion must also route to inventory while one lease is active
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "owner2",
      isSubagentOwned: true,
      payload: { kind: "tool_result", toolUseId: "task2", content: "y" },
    });

    items = emitQueue.peek({ class: "deferred_output", ownerId: "owner2" });
    expect(items).toHaveLength(2);
    expect(items[0]?.target).toBe("inventory");
    expect(items[1]?.target).toBe("inventory");

    // Repeated stale release of the first lease is a no-op
    release1();
    items = emitQueue.peek({ class: "deferred_output", ownerId: "owner2" });
    expect(items[0]?.target).toBe("inventory");
    expect(items[1]?.target).toBe("inventory");

    // Releasing the last lease promotes both exactly once to "both"
    release2();
    items = emitQueue.peek({ class: "deferred_output", ownerId: "owner2" });
    expect(items[0]?.target).toBe("both");
    expect(items[1]?.target).toBe("both");
  });
});
