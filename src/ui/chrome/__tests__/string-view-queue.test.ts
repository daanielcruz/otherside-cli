import { afterEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import {
  clearAgentSteers,
  queueAgentSteer,
  resetSteerEmitThrottleForTests,
} from "@/engine/background/subagents/fork/steering.ts";
import { queueStore } from "@/store/queue-store/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewQueue } from "@/ui/chrome/string-view-queue.ts";

const STEER_FORK = "fork-queue-test";
const originalColorLevel = chalk.level;
chalk.level = 3;

afterEach(() => {
  queueStore.setState(() => ({ messages: [] }));
  clearAgentSteers(STEER_FORK);
  resetSteerEmitThrottleForTests();
  chalk.level = originalColorLevel;
  chalk.level = 3;
});

describe("StringViewQueue", () => {
  it("renders nothing when the queue is empty", () => {
    expect(new StringViewQueue().render(80)).toEqual([]);
  });

  it("renders one badge row per queued message, indented", () => {
    queueStore.setState(() => ({
      messages: [
        { id: "q1", text: "first queued", expanded: "first queued" },
        { id: "q2", text: "second queued", expanded: "second queued" },
      ],
    }));

    const rows = new StringViewQueue().render(80).map(stripAnsi);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.startsWith("  ")).toBe(true);
    expect(rows[0]).toContain("first queued");
    expect(rows[1]).toContain("second queued");
  });

  it("subscribes to queue changes and unsubscribes on teardown", () => {
    const queue = new StringViewQueue();
    let renders = 0;
    queue.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });

    queueStore.setState(() => ({ messages: [{ id: "q1", text: "hi", expanded: "hi" }] }));
    expect(renders).toBe(1);

    queue.unmount();
    queueStore.setState(() => ({ messages: [] }));
    expect(renders).toBe(1);
  });

  it("repaints when an agent steer queues, and stops after teardown", () => {
    const queue = new StringViewQueue();
    let renders = 0;
    queue.mount({ requestRender: () => renders++, pushFocus: () => {}, popFocus: () => {} });

    queueAgentSteer(STEER_FORK, { text: "steer", blocks: [] });
    expect(renders).toBe(1);

    queue.unmount();
    resetSteerEmitThrottleForTests();
    queueAgentSteer(STEER_FORK, { text: "again", blocks: [] });
    expect(renders).toBe(1);
  });
});
