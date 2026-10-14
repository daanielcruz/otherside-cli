import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  _resetGoalInterruptionsForTesting,
  goalAfterTurn,
  goalHeardFromUser,
} from "@/engine/queue/runtime/goal-after-turn.ts";
import type { TurnEnding } from "@/engine/queue/runtime/turn/turn-ending.ts";
import { _resetGoalsForTesting, getActiveGoal, setActiveGoal } from "@/engine/queue/state.ts";
import type { Session } from "@/engine/session/index.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

const SESSION_ID = "session-1";
const session = {
  id: SESSION_ID,
  cwd: "/tmp/<project>",
  messages: [],
  records: [],
} as never as Session;
const CONDITION = "all tests pass";

function noticesAfter(ending: TurnEnding): AgentEvent[] {
  return [...goalAfterTurn(session, ending)];
}

function goalCheckIns(): string[] {
  return emitQueue
    .peek()
    .flatMap((item) => (item.payload.kind === "task_notification_xml" ? [item.payload.text] : []));
}

let previousMinutes: string | undefined;

beforeEach(() => {
  previousMinutes = process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  delete process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  setRuntimeKind("interactive");
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  emitQueue._resetForTests();
  setActiveGoal(SESSION_ID, CONDITION);
});

afterEach(() => {
  jest.useRealTimers();
  if (previousMinutes === undefined) delete process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  else process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES = previousMinutes;
  setRuntimeKind(null);
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  emitQueue._resetForTests();
});

describe("a goal after a turn that failed but may recover", () => {
  test("announces a retry with its delay and count", () => {
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([
      {
        kind: "turn_notice",
        text: "Goal still active · the API was unavailable or the connection dropped · retrying in 1 min (1/3) · send a message to retry now",
        level: "notice",
      },
    ]);
  });

  test("names each recoverable cause", () => {
    const labels: Array<[TurnEnding, string]> = [
      [
        { reason: "request_failed", failure: "unclassified" },
        "the API returned an unexpected response",
      ],
      [{ reason: "tool_call_unreadable" }, "the model's tool call could not be read"],
      [{ reason: "completed", goalCheck: "failed" }, "the goal check could not complete"],
    ];
    for (const [ending, label] of labels) {
      _resetGoalInterruptionsForTesting();
      expect(noticesAfter(ending)).toEqual([
        {
          kind: "turn_notice",
          text: `Goal still active · ${label} · retrying in 1 min (1/3) · send a message to retry now`,
          level: "notice",
        },
      ]);
    }
  });

  test("stays quiet while a retry is already waiting", () => {
    noticesAfter({ reason: "request_failed", failure: "transient" });
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([]);
  });

  test("delivers a check-in when the retry is due and the session is idle", () => {
    jest.useFakeTimers();
    noticesAfter({ reason: "request_failed", failure: "transient" });
    expect(goalCheckIns()).toEqual([]);
    jest.advanceTimersByTime(72_001);
    expect(goalCheckIns()).toEqual([
      "<task-notification>\n<summary>Goal check-in: continuing after the last turn ended early</summary>\n</task-notification>\n<system-reminder>\nGoal check-in: «all tests pass» is still active. The last turn ended before the goal could be evaluated: the API was unavailable or the connection dropped. Continue toward the goal.\n</system-reminder>",
    ]);
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("waits for a busy session before it delivers", () => {
    jest.useFakeTimers();
    noticesAfter({ reason: "request_failed", failure: "transient" });
    emitQueue.setTurnActive(true);
    jest.advanceTimersByTime(72_001);
    expect(goalCheckIns()).toEqual([]);
    emitQueue.setTurnActive(false);
    jest.advanceTimersByTime(60_000);
    expect(goalCheckIns()).toHaveLength(1);
  });

  test("drops a due retry once the goal it was armed for is gone", () => {
    jest.useFakeTimers();
    noticesAfter({ reason: "request_failed", failure: "transient" });
    setActiveGoal(SESSION_ID, "a different goal");
    jest.advanceTimersByTime(72_001);
    expect(goalCheckIns()).toEqual([]);
  });

  test("backs off, then gives up once, after three retries", () => {
    jest.useFakeTimers();
    const minutes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [notice] = noticesAfter({ reason: "request_failed", failure: "transient" });
      minutes.push(String((notice as { text: string }).text.match(/retrying in (\d+) min/)?.[1]));
      jest.advanceTimersByTime(18 * 60_000);
      emitQueue._resetForTests();
    }
    expect(minutes).toEqual(["1", "5", "15"]);
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([
      {
        kind: "turn_notice",
        text: "Goal paused after 3 automatic retries · the API was unavailable or the connection dropped · send a message to continue",
        level: "warning",
      },
    ]);
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([]);
  });

  test("starts over after the user writes", () => {
    noticesAfter({ reason: "request_failed", failure: "transient" });
    goalHeardFromUser(SESSION_ID);
    const [notice] = noticesAfter({ reason: "request_failed", failure: "transient" });
    expect((notice as { text: string }).text).toContain("(1/3)");
  });
});

describe("a goal after a turn that needs the user", () => {
  const pauses: Array<[TurnEnding, string]> = [
    [
      { reason: "request_failed", failure: "rejected" },
      "Goal paused · the API rejected the last request · send a message to continue, or run /goal clear",
    ],
    [
      { reason: "model_failed" },
      "Goal paused · the last turn could not finish · send a message to continue",
    ],
    [
      { reason: "completed", goalCheck: "timed_out" },
      "Goal paused · the goal check timed out · send a message to continue",
    ],
    [
      { reason: "completed", goalCheck: "not_met" },
      "Goal paused · goal checks kept finding it unmet this turn · send a message to continue",
    ],
    [
      { reason: "request_failed", failure: "rate_limited" },
      "Goal paused · the request was rate limited · send a message to retry",
    ],
    [
      { reason: "request_failed", failure: "usage_limit" },
      "Goal paused · usage limit reached · send a message after it resets to continue",
    ],
  ];

  test("says why it paused, once per cause", () => {
    for (const [ending, text] of pauses) {
      _resetGoalInterruptionsForTesting();
      expect(noticesAfter(ending)).toEqual([{ kind: "turn_notice", text, level: "notice" }]);
      expect(noticesAfter(ending)).toEqual([]);
    }
  });

  test("cancels a waiting retry", () => {
    jest.useFakeTimers();
    noticesAfter({ reason: "request_failed", failure: "transient" });
    noticesAfter({ reason: "request_failed", failure: "rejected" });
    jest.advanceTimersByTime(20 * 60_000);
    expect(goalCheckIns()).toEqual([]);
  });

  test("keeps the goal", () => {
    noticesAfter({ reason: "request_failed", failure: "usage_limit" });
    expect(getActiveGoal(SESSION_ID)?.condition).toBe(CONDITION);
  });
});

describe("a goal after a turn no retry can recover", () => {
  const clears: Array<[TurnEnding, string]> = [
    [{ reason: "request_failed", failure: "auth" }, "authentication failed"],
    [{ reason: "request_failed", failure: "verification" }, "organization verification required"],
    [{ reason: "request_failed", failure: "billing" }, "credit balance too low"],
    [{ reason: "request_failed", failure: "model_unavailable" }, "model unavailable"],
    [{ reason: "request_failed", failure: "context_full" }, "context limit reached"],
    [{ reason: "context_full" }, "context limit reached"],
  ];

  test("clears it and says how to start again", () => {
    for (const [ending, label] of clears) {
      setActiveGoal(SESSION_ID, CONDITION);
      expect(noticesAfter(ending)).toEqual([
        {
          kind: "turn_notice",
          text: `Goal cleared after an unrecoverable error (${label}): "${CONDITION}". Run /goal again to continue.`,
          level: "warning",
        },
      ]);
      expect(getActiveGoal(SESSION_ID)).toBeUndefined();
    }
  });

  test("clears it outside an interactive session too", () => {
    setRuntimeKind("print");
    expect(noticesAfter({ reason: "request_failed", failure: "billing" })).toHaveLength(1);
    expect(getActiveGoal(SESSION_ID)).toBeUndefined();
  });

  test("quotes only the first line of a long condition", () => {
    setActiveGoal(SESSION_ID, `${"x".repeat(100)}\nsecond line`);
    const [notice] = noticesAfter({ reason: "request_failed", failure: "auth" });
    expect((notice as { text: string }).text).toContain(`"${"x".repeat(79)}…"`);
  });
});

describe("a goal after a turn that needs nothing from it", () => {
  test("says nothing when the goal was judged or the turn was cancelled", () => {
    const endings: TurnEnding[] = [
      { reason: "completed", goalCheck: "met" },
      { reason: "completed", goalCheck: "impossible" },
      { reason: "completed", goalCheck: "deferred" },
      { reason: "completed" },
      { reason: "cancelled" },
    ];
    for (const ending of endings) expect(noticesAfter(ending)).toEqual([]);
  });

  test("a verdict closes the streak, so the next interruption counts from one", () => {
    noticesAfter({ reason: "request_failed", failure: "transient" });
    noticesAfter({ reason: "completed", goalCheck: "deferred" });
    const [notice] = noticesAfter({ reason: "request_failed", failure: "transient" });
    expect((notice as { text: string }).text).toContain("(1/3)");
  });

  test("stays silent without retries or pauses outside an interactive session", () => {
    setRuntimeKind("print");
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([]);
    expect(noticesAfter({ reason: "request_failed", failure: "rate_limited" })).toEqual([]);
  });

  test("stays silent when check-ins are turned off", () => {
    process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES = "0";
    expect(noticesAfter({ reason: "request_failed", failure: "transient" })).toEqual([]);
    expect(noticesAfter({ reason: "model_failed" })).toEqual([]);
  });

  test("has nothing to do without a goal", () => {
    _resetGoalsForTesting();
    expect(noticesAfter({ reason: "request_failed", failure: "auth" })).toEqual([]);
  });
});
