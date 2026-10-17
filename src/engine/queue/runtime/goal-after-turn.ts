import { emitQueue } from "@/engine/queue/emit.ts";
import { type ActiveGoal, clearActiveGoal, getActiveGoal } from "@/engine/queue/state.ts";
import {
  appendRecord,
  goalStatusAttachment,
  nowIso,
  type Session,
} from "@/engine/session/index.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestFailure } from "@/kernel/std/types/error-meta.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import {
  deliverGoalCheckIn,
  goalCheckInIntervalMs,
  goalCheckInLead,
  goalCheckInQueued,
  isSameGoal,
  resetGoalIdleCheckIns,
} from "./goal-check-in.ts";
import type { GoalCheckOutcome, TurnEnding } from "./turn/turn-ending.ts";
import { turnNotice } from "./turn-notice.ts";

// A turn that ends before its goal could be judged leaves the goal in one of
// three places: retried automatically after a delay, paused until the user
// writes again, or cleared when no retry can succeed. Each is announced once
// per goal and cause; a message from the user starts the count over.

type RetryCause = "api_unavailable" | "unclassified" | "unreadable_tool_call" | "goal_check";

type PauseCause =
  | "request_rejected"
  | "turn_error"
  | "goal_check_timeout"
  | "goal_check_capped"
  | "rate_limited"
  | "usage_limit";

type ClearCause =
  | "auth"
  | "verification_required"
  | "billing"
  | "context_limit"
  | "model_unavailable";

type GoalTurnAction =
  | { kind: "none" }
  | { kind: "retry"; cause: RetryCause }
  | { kind: "pause"; cause: PauseCause }
  | { kind: "clear"; cause: ClearCause };

const RETRY_LABELS: Record<RetryCause, string> = {
  api_unavailable: "the API was unavailable or the connection dropped",
  unclassified: "the API returned an unexpected response",
  unreadable_tool_call: "the model's tool call could not be read",
  goal_check: "the goal check could not complete",
};

const PAUSE_NOTICES: Record<PauseCause, string> = {
  request_rejected:
    "Goal paused · the API rejected the last request · send a message to continue, or run /goal clear",
  turn_error: "Goal paused · the last turn could not finish · send a message to continue",
  goal_check_timeout: "Goal paused · the goal check timed out · send a message to continue",
  goal_check_capped:
    "Goal paused · goal checks kept finding it unmet this turn · send a message to continue",
  rate_limited: "Goal paused · the request was rate limited · send a message to retry",
  usage_limit: "Goal paused · usage limit reached · send a message after it resets to continue",
};

const CLEAR_LABELS: Record<ClearCause, string> = {
  auth: "authentication failed",
  verification_required: "organization verification required",
  billing: "credit balance too low",
  context_limit: "context limit reached",
  model_unavailable: "model unavailable",
};

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
const RETRY_JITTER = 0.2;
const MAX_RETRIES = RETRY_DELAYS_MS.length;
/** How soon a due retry looks again when the session was busy or a check-in was waiting. */
const BUSY_RECHECK_MS = 60_000;
const CLEARED_CONDITION_CHARS = 80;

interface GoalInterruption {
  goalSetAt: number;
  retries: number;
  announced?: PauseCause | "gave_up";
}

const interruptionBySession = new Map<string, GoalInterruption>();
const retryTimerBySession = new Map<string, ReturnType<typeof setTimeout>>();

/** The user wrote: retries start over and idle check-ins may run again. */
export function goalHeardFromUser(sessionId: string): void {
  forgetGoalInterruption(sessionId);
  resetGoalIdleCheckIns(sessionId);
}

function forgetGoalInterruption(sessionId: string): void {
  cancelGoalRetry(sessionId);
  interruptionBySession.delete(sessionId);
}

/** What the session's goal does now that a main turn has ended for `ending`. */
export function* goalAfterTurn(session: Session, ending: TurnEnding): Generator<AgentEvent> {
  const goal = getActiveGoal(session.id);
  if (goal === undefined || ending.reason === "cancelled") {
    forgetGoalInterruption(session.id);
    return;
  }
  const action = goalTurnAction(ending);
  if (action.kind === "none") {
    // A verdict, or an ending that is not an interruption, closes the streak; a
    // finished turn that never reached a verdict leaves it as it was.
    if (ending.reason !== "completed" || ending.goalCheck !== undefined) {
      forgetGoalInterruption(session.id);
    }
    return;
  }
  if (action.kind === "clear") {
    forgetGoalInterruption(session.id);
    yield* clearGoal(session, goal, action.cause);
    return;
  }
  if (goalCheckInIntervalMs() === 0 || getRuntimeKind() !== "interactive") {
    forgetGoalInterruption(session.id);
    return;
  }
  const streak = interruptionBySession.get(session.id);
  const sameGoal = streak?.goalSetAt === goal.setAt;
  const retries = sameGoal ? streak.retries : 0;
  const announced = sameGoal ? streak.announced : undefined;
  if (action.kind === "retry") {
    if (sameGoal && (retryTimerBySession.has(session.id) || goalCheckInQueued())) return;
    const label = RETRY_LABELS[action.cause];
    if (retries >= MAX_RETRIES) {
      if (announced === "gave_up") return;
      interruptionBySession.set(session.id, {
        goalSetAt: goal.setAt,
        retries,
        announced: "gave_up",
      });
      yield turnNotice(
        session,
        `Goal paused after ${MAX_RETRIES} automatic retries · ${label} · send a message to continue`,
        "warning",
      );
      return;
    }
    interruptionBySession.set(session.id, { goalSetAt: goal.setAt, retries: retries + 1 });
    const delayMs = RETRY_DELAYS_MS[retries] ?? RETRY_DELAYS_MS[0];
    armGoalRetry(session.id, goal, label, Math.round(delayMs * (1 + Math.random() * RETRY_JITTER)));
    yield turnNotice(
      session,
      `Goal still active · ${label} · retrying in ${Math.round(delayMs / 60_000)} min (${retries + 1}/${MAX_RETRIES}) · send a message to retry now`,
      "notice",
    );
    return;
  }
  cancelGoalRetry(session.id);
  if (announced === action.cause) return;
  interruptionBySession.set(session.id, {
    goalSetAt: goal.setAt,
    retries,
    announced: action.cause,
  });
  yield turnNotice(session, PAUSE_NOTICES[action.cause], "notice");
}

function goalTurnAction(ending: TurnEnding): GoalTurnAction {
  switch (ending.reason) {
    case "completed":
      return goalCheckAction(ending.goalCheck);
    case "cancelled":
      return { kind: "none" };
    case "context_full":
      return { kind: "clear", cause: "context_limit" };
    case "model_failed":
      return { kind: "pause", cause: "turn_error" };
    case "tool_call_unreadable":
      return { kind: "retry", cause: "unreadable_tool_call" };
    case "request_failed":
      return requestFailureAction(ending.failure);
  }
}

function goalCheckAction(outcome: GoalCheckOutcome | undefined): GoalTurnAction {
  switch (outcome) {
    case "failed":
      return { kind: "retry", cause: "goal_check" };
    case "timed_out":
      return { kind: "pause", cause: "goal_check_timeout" };
    case "not_met":
      return { kind: "pause", cause: "goal_check_capped" };
    case "met":
    case "impossible":
    case "deferred":
    case undefined:
      return { kind: "none" };
  }
}

function requestFailureAction(failure: RequestFailure): GoalTurnAction {
  switch (failure) {
    case "rate_limited":
      return { kind: "pause", cause: "rate_limited" };
    case "usage_limit":
      return { kind: "pause", cause: "usage_limit" };
    case "transient":
      return { kind: "retry", cause: "api_unavailable" };
    case "unclassified":
      return { kind: "retry", cause: "unclassified" };
    case "rejected":
      return { kind: "pause", cause: "request_rejected" };
    case "auth":
      return { kind: "clear", cause: "auth" };
    case "verification":
      return { kind: "clear", cause: "verification_required" };
    case "billing":
      return { kind: "clear", cause: "billing" };
    case "model_unavailable":
      return { kind: "clear", cause: "model_unavailable" };
    case "context_full":
      return { kind: "clear", cause: "context_limit" };
  }
}

function* clearGoal(session: Session, goal: ActiveGoal, cause: ClearCause): Generator<AgentEvent> {
  clearActiveGoal(session.id);
  appendRecord(session, {
    type: "attachment",
    ts: nowIso(),
    attachment: goalStatusAttachment(goal.condition, {
      met: false,
      failed: true,
      reason: CLEAR_LABELS[cause],
    }),
  }).catch(() => {});
  yield turnNotice(
    session,
    `Goal cleared after an unrecoverable error (${CLEAR_LABELS[cause]}): "${conditionExcerpt(goal.condition)}". Run /goal again to continue.`,
    "warning",
  );
}

/** The condition's first line, marked when more of it was left out. */
function conditionExcerpt(condition: string): string {
  const firstLine = condition.split("\n", 1)[0] ?? "";
  const excerpt = firstLine.length < condition.length ? `${firstLine}…` : firstLine;
  return truncateEllipsis(excerpt, CLEARED_CONDITION_CHARS);
}

function armGoalRetry(sessionId: string, goal: ActiveGoal, cause: string, delayMs: number): void {
  cancelGoalRetry(sessionId);
  const timer = setTimeout(() => fireGoalRetry(sessionId, goal, cause), delayMs);
  timer.unref?.();
  retryTimerBySession.set(sessionId, timer);
}

function cancelGoalRetry(sessionId: string): void {
  const timer = retryTimerBySession.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  retryTimerBySession.delete(sessionId);
}

function fireGoalRetry(sessionId: string, armedFor: ActiveGoal, cause: string): void {
  retryTimerBySession.delete(sessionId);
  const goal = getActiveGoal(sessionId);
  if (!isSameGoal(goal, armedFor) || goalCheckInIntervalMs() === 0) return;
  if (emitQueue.isTurnActive() || goalCheckInQueued()) {
    armGoalRetry(sessionId, armedFor, cause, BUSY_RECHECK_MS);
    return;
  }
  deliverGoalCheckIn({
    summary: "Goal check-in: continuing after the last turn ended early",
    body: `${goalCheckInLead(goal.condition)} is still active. The last turn ended before the goal could be evaluated: ${cause}. Continue toward the goal.`,
  });
}

export function _resetGoalInterruptionsForTesting(): void {
  for (const timer of retryTimerBySession.values()) clearTimeout(timer);
  retryTimerBySession.clear();
  interruptionBySession.clear();
}
