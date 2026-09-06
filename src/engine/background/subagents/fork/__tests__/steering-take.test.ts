import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAgentSteers,
  pendingAgentSteers,
  queueAgentSteer,
  takeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";

const FORK = "fork_steering_take";

function queue(text: string): string {
  queueAgentSteer(FORK, { text, blocks: [{ type: "text", text }] });
  const queued = pendingAgentSteers(FORK).at(-1);
  return queued?.queueId ?? "";
}

describe("takeAgentSteers", () => {
  afterEach(() => clearAgentSteers(FORK));

  test("takes the listed steers and leaves the rest queued in order", () => {
    const first = queue("before one");
    const second = queue("before two");
    queue("after");

    const taken = takeAgentSteers(FORK, new Set([first, second]));

    expect(taken.map((steer) => steer.text)).toEqual(["before one", "before two"]);
    expect(pendingAgentSteers(FORK).map((steer) => steer.text)).toEqual(["after"]);
  });

  test("an empty claim leaves the queue untouched", () => {
    queue("still waiting");

    expect(takeAgentSteers(FORK, new Set())).toEqual([]);
    expect(pendingAgentSteers(FORK).map((steer) => steer.text)).toEqual(["still waiting"]);
  });

  test("claiming every steer empties the queue", () => {
    const only = queue("solo");

    expect(takeAgentSteers(FORK, new Set([only])).map((steer) => steer.text)).toEqual(["solo"]);
    expect(pendingAgentSteers(FORK)).toEqual([]);
  });
});
