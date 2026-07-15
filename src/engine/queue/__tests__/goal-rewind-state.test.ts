import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetGoalsForTesting,
  clearActiveGoal,
  getActiveGoal,
  setActiveGoal,
} from "@/engine/queue/state.ts";

const SESSION = "goal-rewind-test-session";

afterEach(() => {
  _resetGoalsForTesting();
});

// Rewind discipline: goal hook events are memory-only and never persisted, so
// a conversation rewind always clears the active goal — same as resume, the
// user re-sets /goal if still relevant.
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
