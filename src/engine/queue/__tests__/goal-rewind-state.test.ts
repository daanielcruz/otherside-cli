import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetGoalsForTesting,
  clearActiveGoal,
  getActiveGoal,
  restoreGoalFromRecords,
  setActiveGoal,
} from "@/engine/queue/state.ts";

const SESSION = "goal-rewind-test-session";

afterEach(() => {
  _resetGoalsForTesting();
});

describe("goal state across conversation rewind", () => {
  test("active goal does not survive the rewind clear", () => {
    setActiveGoal(SESSION, "must not survive rewind");
    clearActiveGoal(SESSION);
    expect(getActiveGoal(SESSION)).toBeUndefined();
  });

  test("clearing is scoped to the rewound session", () => {
    setActiveGoal(SESSION, "rewound session goal");
    setActiveGoal("other-session", "unrelated goal");
    clearActiveGoal(SESSION);
    expect(getActiveGoal(SESSION)).toBeUndefined();
    expect(getActiveGoal("other-session")?.condition).toBe("unrelated goal");
  });
});

describe("goal state restoration", () => {
  test("clears stale memory when the retained transcript has no active goal", () => {
    setActiveGoal(SESSION, "removed goal");

    expect(restoreGoalFromRecords(SESSION, [])).toBeUndefined();
    expect(getActiveGoal(SESSION)).toBeUndefined();
  });

  test("restores the latest unmet transcript goal with its evaluation state", () => {
    const restored = restoreGoalFromRecords(SESSION, [
      {
        type: "attachment",
        ts: "2026-07-18T10:00:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "old goal",
          met: false,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:01:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "old goal",
          met: true,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:02:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:03:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
          reason: "one test is still failing",
          iteration: 2,
        },
      },
    ]);

    expect(restored).toEqual({
      condition: "tests pass",
      iterations: 2,
      lastReason: "one test is still failing",
      setAt: Date.parse("2026-07-18T10:02:00.000Z"),
    });
  });

  test("resets iterations when the same goal condition is set again", () => {
    const restored = restoreGoalFromRecords(SESSION, [
      {
        type: "attachment",
        ts: "2026-07-18T10:00:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:01:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
          reason: "one test is still failing",
          iteration: 2,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:02:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
        },
      },
    ]);

    expect(restored).toEqual({
      condition: "tests pass",
      iterations: 0,
      setAt: Date.parse("2026-07-18T10:02:00.000Z"),
    });
  });

  test("does not restore a completed transcript goal", () => {
    const restored = restoreGoalFromRecords(SESSION, [
      {
        type: "attachment",
        ts: "2026-07-18T10:00:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: false,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:01:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "tests pass",
          met: true,
          sentinel: true,
        },
      },
    ]);

    expect(restored).toBeUndefined();
    expect(getActiveGoal(SESSION)).toBeUndefined();
  });

  test("does not restore a goal classified as impossible", () => {
    const restored = restoreGoalFromRecords(SESSION, [
      {
        type: "attachment",
        ts: "2026-07-18T10:00:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "unreachable condition",
          met: false,
          sentinel: true,
        },
      },
      {
        type: "attachment",
        ts: "2026-07-18T10:01:00.000Z",
        attachment: {
          type: "goal_status",
          condition: "unreachable condition",
          met: false,
          sentinel: true,
          failed: true,
          reason: "required capability is unavailable",
          iteration: 1,
        },
      },
    ]);

    expect(restored).toBeUndefined();
    expect(getActiveGoal(SESSION)).toBeUndefined();
  });
});
