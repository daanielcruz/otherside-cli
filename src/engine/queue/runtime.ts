import { pluralize } from "@/kernel/std/text/pluralize.ts";
import {
  type ActiveGoal,
  clearActiveGoal,
  getActiveGoal,
  MAX_GOAL_CHARS,
  setActiveGoal,
} from "./state.ts";

interface GoalRecordLike {
  type: string;
  kind?: string;
  payload?: unknown;
  ts?: string;
  attachment?: unknown;
}

export const BULLSEYE = "◎";

const CLEAR_KEYWORDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

export function isGoalClearKeyword(s: string): boolean {
  return CLEAR_KEYWORDS.has(s.trim().toLowerCase());
}

export interface GoalCommandResult {
  feedback: string;
  metaMessage?: string;
  event?:
    | { kind: "goal_set"; condition: string; setAt: number }
    | { kind: "goal_cleared"; condition: string };
}

export function runGoal(
  sessionId: string,
  args: string,
  _opts: { records?: ReadonlyArray<GoalRecordLike> } = {},
): GoalCommandResult {
  const trimmed = args.trim();

  if (trimmed === "") {
    return { feedback: formatGoalStatus(getActiveGoal(sessionId)) };
  }

  if (isGoalClearKeyword(trimmed)) {
    const cleared = clearActiveGoal(sessionId);
    if (cleared === undefined) return { feedback: "No goal set" };
    return {
      feedback: `Goal cleared: ${cleared.condition}`,
      event: { kind: "goal_cleared", condition: cleared.condition },
    };
  }

  if (trimmed.length > MAX_GOAL_CHARS) {
    return {
      feedback: `Goal condition is limited to ${MAX_GOAL_CHARS} characters (got ${trimmed.length})`,
    };
  }

  const goal = setActiveGoal(sessionId, trimmed);
  return {
    feedback: `Goal set: ${trimmed}`,
    metaMessage: composeGoalMetaMessage(trimmed),
    event: { kind: "goal_set", condition: trimmed, setAt: goal.setAt },
  };
}

export function formatGoalStatus(goal: ActiveGoal | undefined): string {
  if (goal === undefined) {
    return "No goal set. Usage: `/goal <condition>`";
  }
  const iterationsLabel =
    goal.iterations === 0
      ? "not yet evaluated"
      : `${goal.iterations} ${pluralize(goal.iterations, "turn")}`;
  const reasonSuffix = goal.lastReason ? `\n${formatLastCheck(goal.lastReason)}` : "";
  return `Goal active: ${goal.condition} (${iterationsLabel})${reasonSuffix}`;
}

function formatLastCheck(reason: string): string {
  const firstLine = reason.split("\n")[0] ?? "";
  return `Last check: ${firstLine.trim()}`;
}

function composeGoalMetaMessage(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Coarsest unit that fits the span, so the readout stays one short token. */
function formatGoalElapsed(elapsedMs: number): string {
  if (elapsedMs >= DAY_MS) return `${Math.floor(elapsedMs / DAY_MS)}d`;
  if (elapsedMs >= HOUR_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  if (elapsedMs >= MINUTE_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  return `${Math.floor(elapsedMs / SECOND_MS)}s`;
}

/** The span is omitted for the first second, while it has nothing to say yet. */
export function formatGoalStatusBar(goal: ActiveGoal, now: number = Date.now()): string {
  const elapsedMs = Math.max(0, now - goal.setAt);
  const span = elapsedMs < SECOND_MS ? "" : ` (${formatGoalElapsed(elapsedMs)})`;
  return `${BULLSEYE} /goal active${span}`;
}
