import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  clear as clearBackgroundTasks,
  startShellTask,
} from "@/engine/background/tasks/background.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { goalHeardFromUser } from "@/engine/queue/runtime/goal-after-turn.ts";
import {
  _resetGoalCheckInsForTesting,
  armGoalIdleCheckIn,
  type DeferringWork,
  holdGoalCheck,
  releaseGoalCheck,
  sessionDeferringWork,
} from "@/engine/queue/runtime/goal-check-in.ts";
import { _resetGoalsForTesting, getActiveGoal, setActiveGoal } from "@/engine/queue/state.ts";

const SESSION_ID = "session-1";
const MINUTE = 60_000;

function work(startedAt: number, description = "bun test --watch"): DeferringWork[] {
  return [{ id: "b1", kind: "shell", description, startedAt }];
}

function holdAt(now: number, running = work(0)): string | undefined {
  const goal = getActiveGoal(SESSION_ID);
  if (goal === undefined) throw new Error("no goal");
  return holdGoalCheck(SESSION_ID, goal, running, now);
}

function deliveredSummaries(): string[] {
  return emitQueue
    .peek()
    .flatMap((item) =>
      item.payload.kind === "task_notification_xml" ? [item.payload.summary ?? ""] : [],
    );
}

let previousMinutes: string | undefined;

beforeEach(() => {
  previousMinutes = process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  delete process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  _resetGoalsForTesting();
  _resetGoalCheckInsForTesting();
  clearBackgroundTasks();
  emitQueue._resetForTests();
  setActiveGoal(SESSION_ID, "the build is green");
});

afterEach(() => {
  jest.useRealTimers();
  if (previousMinutes === undefined) delete process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  else process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES = previousMinutes;
  _resetGoalsForTesting();
  _resetGoalCheckInsForTesting();
  clearBackgroundTasks();
  emitQueue._resetForTests();
});

describe("a goal check held back by background work", () => {
  test("waits out the interval before it checks in", () => {
    expect(holdAt(0)).toBeUndefined();
    expect(holdAt(29 * MINUTE)).toBeUndefined();
    expect(holdAt(30 * MINUTE)).toBe(
      "Goal check-in: «the build is green» is still active, and evaluation has been deferred for 30 min because background work is still running:\n" +
        "- b1 · shell · bun test --watch\n" +
        "Check on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.",
    );
  });

  test("doubles the wait after each check-in, up to four intervals", () => {
    let now = 0;
    holdAt(now);
    const gaps: number[] = [];
    for (let checkIn = 0; checkIn < 4; checkIn += 1) {
      const start = now;
      do now += MINUTE;
      while (holdAt(now) === undefined);
      gaps.push((now - start) / MINUTE);
    }
    expect(gaps).toEqual([30, 60, 120, 120]);
  });

  test("starts a new wait for work begun long after the last held-back turn", () => {
    holdAt(0);
    holdAt(30 * MINUTE);
    const lateWork = work(100 * MINUTE);
    expect(holdAt(101 * MINUTE, lateWork)).toBeUndefined();
    expect(getActiveGoal(SESSION_ID)?.deferral).toEqual({
      since: 101 * MINUTE,
      checkIns: 0,
      lastPassAt: 101 * MINUTE,
    });
  });

  test("puts each piece of work on one escaped, clipped line", () => {
    holdAt(0);
    const text = holdAt(30 * MINUTE, work(0, `npm run <long>\n${"x".repeat(200)}`)) ?? "";
    const line = text.split("\n").find((row) => row.startsWith("- b1"));
    expect(line).toStartWith("- b1 · shell · npm run &lt;long&gt; xxx");
    expect(line).toEndWith("… [+110 chars]");
  });

  test("is released once no work holds it back", () => {
    holdAt(0);
    releaseGoalCheck(SESSION_ID);
    expect(getActiveGoal(SESSION_ID)?.deferral).toBeUndefined();
  });

  test("never checks in when check-ins are turned off", () => {
    process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES = "0";
    holdAt(0);
    expect(holdAt(300 * MINUTE)).toBeUndefined();
  });

  test("names the background work this session owns", () => {
    startShellTask({
      shellId: "shell-1",
      command: "sleep 999",
      parentToolCallId: "tool-1",
      sessionId: SESSION_ID,
    });
    startShellTask({
      shellId: "shell-2",
      command: "sleep 1",
      parentToolCallId: "tool-2",
      sessionId: "session-2",
    });
    expect(
      sessionDeferringWork(SESSION_ID).map(({ kind, description }) => [kind, description]),
    ).toEqual([["shell", "sleep 999"]]);
  });
});

describe("an idle session whose goal check is held back", () => {
  test("is woken with a check-in when it comes due", () => {
    jest.useFakeTimers();
    startShellTask({
      shellId: "shell-1",
      command: "sleep 999",
      parentToolCallId: "tool-1",
      sessionId: SESSION_ID,
    });
    holdAt(Date.now(), sessionDeferringWork(SESSION_ID));
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    jest.advanceTimersByTime(29 * MINUTE);
    expect(deliveredSummaries()).toEqual([]);
    jest.advanceTimersByTime(MINUTE);
    expect(deliveredSummaries()).toEqual(["Goal check-in: background work still running"]);
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("says so when the work stopped without reporting back", () => {
    jest.useFakeTimers();
    holdAt(Date.now());
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    jest.advanceTimersByTime(30 * MINUTE);
    expect(deliveredSummaries()).toEqual(["Goal check-in: background work no longer running"]);
  });

  test("waits while a turn runs or a notification is about to wake it", () => {
    jest.useFakeTimers();
    holdAt(Date.now());
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    emitQueue.setTurnActive(true);
    jest.advanceTimersByTime(30 * MINUTE);
    expect(deliveredSummaries()).toEqual([]);
    emitQueue.setTurnActive(false);
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: { kind: "task_notification_xml", text: "<task-notification/>", summary: "done" },
      autoTurn: true,
    });
    jest.advanceTimersByTime(MINUTE);
    expect(deliveredSummaries()).toEqual(["done"]);
  });

  test("stops after three idle check-ins, saying so on the last, until the user writes", () => {
    jest.useFakeTimers();
    holdAt(Date.now());
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    const summaries: string[] = [];
    for (let hour = 0; hour < 12; hour += 1) {
      jest.advanceTimersByTime(60 * MINUTE);
      summaries.push(...deliveredSummaries());
      emitQueue._resetForTests();
    }
    expect(summaries).toEqual([
      "Goal check-in: background work no longer running",
      "Goal check-in: background work no longer running",
      "Goal check-in: background work no longer running · idle check-ins paused until your next message",
    ]);
    goalHeardFromUser(SESSION_ID);
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    jest.advanceTimersByTime(120 * MINUTE);
    expect(deliveredSummaries()).toHaveLength(1);
  });

  test("lets a check-in armed for an earlier goal lapse", () => {
    jest.useFakeTimers();
    holdAt(Date.now());
    armGoalIdleCheckIn(SESSION_ID, Date.now());
    setActiveGoal(SESSION_ID, "a different goal");
    jest.advanceTimersByTime(60 * MINUTE);
    expect(deliveredSummaries()).toEqual([]);
  });
});
