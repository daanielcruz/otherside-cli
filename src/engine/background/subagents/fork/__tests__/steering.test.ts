import { describe, expect, test } from "bun:test";
import {
  clearAgentSteers,
  drainAgentSteers,
  pendingAgentSteerCount,
  pendingAgentSteers,
  queueAgentSteer,
  resetSteerEmitThrottleForTests,
  subscribeAgentSteers,
  waitForAgentSteer,
} from "../steering.ts";

describe("agent steering queue", () => {
  test("queues and drains messages per fork", () => {
    const forkId = "fork-steering-test";
    clearAgentSteers(forkId);
    const snapshots: number[] = [];
    const unsubscribe = subscribeAgentSteers(() => {
      snapshots.push(pendingAgentSteerCount(forkId));
    });

    // The emitter throttles leading+trailing; the reset between operations
    // reopens the window so each change notifies immediately for the probe.
    queueAgentSteer(forkId, {
      text: "first",
      blocks: [{ type: "text", text: "first" }],
    });
    resetSteerEmitThrottleForTests();
    queueAgentSteer(forkId, {
      text: "second",
      blocks: [{ type: "text", text: "second" }],
    });
    resetSteerEmitThrottleForTests();

    expect(pendingAgentSteerCount(forkId)).toBe(2);
    expect(drainAgentSteers(forkId).map((message) => message.text)).toEqual(["first", "second"]);
    expect(pendingAgentSteerCount(forkId)).toBe(0);
    expect(snapshots).toEqual([1, 2, 0]);

    unsubscribe();
    resetSteerEmitThrottleForTests();
  });

  test("publishes a new snapshot only when that fork queue changes", () => {
    const forkId = "fork-snapshot-test";
    const otherForkId = "fork-snapshot-other";
    clearAgentSteers(forkId);
    clearAgentSteers(otherForkId);

    const empty = pendingAgentSteers(forkId);
    queueAgentSteer(otherForkId, {
      text: "other",
      blocks: [{ type: "text", text: "other" }],
    });
    expect(pendingAgentSteers(forkId)).toBe(empty);

    queueAgentSteer(forkId, {
      text: "first",
      blocks: [{ type: "text", text: "first" }],
    });
    const first = pendingAgentSteers(forkId);
    expect(first).not.toBe(empty);

    queueAgentSteer(forkId, {
      text: "second",
      blocks: [{ type: "text", text: "second" }],
    });
    const second = pendingAgentSteers(forkId);
    expect(second).not.toBe(first);
    expect(first.map((message) => message.text)).toEqual(["first"]);
    expect(second.map((message) => message.text)).toEqual(["first", "second"]);

    drainAgentSteers(forkId);
    clearAgentSteers(otherForkId);
    expect(pendingAgentSteers(forkId)).toBe(empty);
  });
});

describe("waitForAgentSteer", () => {
  test("resolves immediately when a steer is already queued", async () => {
    const forkId = "fork-wait-prequeued";
    clearAgentSteers(forkId);
    resetSteerEmitThrottleForTests();
    queueAgentSteer(forkId, { text: "early", blocks: [{ type: "text", text: "early" }] });

    await waitForAgentSteer(forkId);
    // Waking is not claiming: the queue still holds the steer for the drainer.
    expect(drainAgentSteers(forkId).map((message) => message.text)).toEqual(["early"]);
    resetSteerEmitThrottleForTests();
  });

  test("wakes when a steer arrives after the wait starts", async () => {
    const forkId = "fork-wait-late";
    clearAgentSteers(forkId);
    resetSteerEmitThrottleForTests();

    const woke = waitForAgentSteer(forkId);
    queueAgentSteer(forkId, { text: "late", blocks: [{ type: "text", text: "late" }] });
    await woke;
    expect(pendingAgentSteerCount(forkId)).toBe(1);
    expect(drainAgentSteers(forkId).map((message) => message.text)).toEqual(["late"]);
    resetSteerEmitThrottleForTests();
  });

  test("a steer for another fork does not wake the waiter", async () => {
    const forkId = "fork-wait-mine";
    const otherForkId = "fork-wait-other";
    clearAgentSteers(forkId);
    clearAgentSteers(otherForkId);
    resetSteerEmitThrottleForTests();

    let woke = false;
    const wait = waitForAgentSteer(forkId).then(() => {
      woke = true;
    });
    queueAgentSteer(otherForkId, { text: "other", blocks: [{ type: "text", text: "other" }] });
    await Promise.resolve();
    expect(woke).toBe(false);

    resetSteerEmitThrottleForTests();
    queueAgentSteer(forkId, { text: "mine", blocks: [{ type: "text", text: "mine" }] });
    await wait;
    expect(woke).toBe(true);
    drainAgentSteers(forkId);
    clearAgentSteers(otherForkId);
    resetSteerEmitThrottleForTests();
  });

  test("abort releases the waiter without consuming anything", async () => {
    const forkId = "fork-wait-abort";
    clearAgentSteers(forkId);
    resetSteerEmitThrottleForTests();

    const controller = new AbortController();
    const woke = waitForAgentSteer(forkId, controller.signal);
    controller.abort();
    await woke;
    expect(pendingAgentSteerCount(forkId)).toBe(0);

    // A released waiter must not fire later: queueing now only feeds the queue.
    queueAgentSteer(forkId, { text: "after", blocks: [{ type: "text", text: "after" }] });
    expect(drainAgentSteers(forkId)).toHaveLength(1);
    resetSteerEmitThrottleForTests();
  });
});
