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
    metaMessage: buildGoalMetaMessage(trimmed),
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

function buildGoalMetaMessage(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

export function formatGoalStatusBar(goal: ActiveGoal): string {
  const minutes = Math.max(0, Math.floor((Date.now() - goal.setAt) / 60_000));
  const elapsed =
    minutes === 0
      ? "<1m"
      : minutes < 60
        ? `${minutes}m`
        : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${BULLSEYE} /goal active (${elapsed})`;
}
