import { describe, expect, test } from "bun:test";
import {
  clearAgentSteers,
  drainAgentSteers,
  pendingAgentSteerCount,
  pendingAgentSteers,
  queueAgentSteer,
  subscribeAgentSteers,
} from "../steering.ts";

describe("agent steering queue", () => {
  test("queues and drains messages per fork", () => {
    const forkId = "fork-steering-test";
    clearAgentSteers(forkId);
    const snapshots: number[] = [];
    const unsubscribe = subscribeAgentSteers(() => {
      snapshots.push(pendingAgentSteerCount(forkId));
    });

    queueAgentSteer(forkId, {
      text: "first",
      blocks: [{ type: "text", text: "first" }],
    });
    queueAgentSteer(forkId, {
      text: "second",
      blocks: [{ type: "text", text: "second" }],
    });

    expect(pendingAgentSteerCount(forkId)).toBe(2);
    expect(drainAgentSteers(forkId).map((message) => message.text)).toEqual(["first", "second"]);
    expect(pendingAgentSteerCount(forkId)).toBe(0);
    expect(snapshots).toEqual([1, 2, 0]);

    unsubscribe();
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
