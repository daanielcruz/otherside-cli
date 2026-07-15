export const MAX_GOAL_CHARS = 4000;

export interface ActiveGoal {
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
}

const goalsBySession = new Map<string, ActiveGoal>();

export function getActiveGoal(sessionId: string): ActiveGoal | undefined {
  return goalsBySession.get(sessionId);
}

export function setActiveGoal(sessionId: string, condition: string): ActiveGoal {
  const goal: ActiveGoal = {
    condition,
    iterations: 0,
    setAt: Date.now(),
  };
  goalsBySession.set(sessionId, goal);
  return goal;
}

export function clearActiveGoal(sessionId: string): ActiveGoal | undefined {
  const goal = goalsBySession.get(sessionId);
  if (goal === undefined) return undefined;
  goalsBySession.delete(sessionId);
  return goal;
}

export function incrementGoalIterations(sessionId: string): void {
  const goal = goalsBySession.get(sessionId);
  if (goal === undefined) return;
  goal.iterations += 1;
}

export function setGoalLastReason(sessionId: string, reason: string | undefined): void {
  const goal = goalsBySession.get(sessionId);
  if (goal === undefined) return;
  if (reason === undefined) delete goal.lastReason;
  else goal.lastReason = reason;
}

export function _resetGoalsForTesting(): void {
  goalsBySession.clear();
}

interface GoalEventRecord {
  type: "hook_event";
  ts: string;
  kind: string;
  payload: unknown;
}

export function restoreGoalFromRecords(
  sessionId: string,
  records: ReadonlyArray<{
    type: string;
    kind?: string;
    payload?: unknown;
    ts?: string;
    isSidechain?: boolean;
    attachment?: unknown;
  }>,
  hookEvents: ReadonlyArray<{ type: string; kind?: string; payload?: unknown; ts?: string }> = [],
): ActiveGoal | undefined {
  const merged = [...records, ...hookEvents] as Array<(typeof records)[number]>;
  let active: ActiveGoal | undefined;
  let iterations = 0;
  for (const r of merged) {
    if ("isSidechain" in r && r.isSidechain === true) continue;
    if (r.type === "hook_event") {
      const payload = r.payload as { condition?: unknown; setAt?: unknown } | null;
      const condition = payload && typeof payload.condition === "string" ? payload.condition : null;
      if (r.kind === "goal_set" && condition !== null) {
        const setAt =
          payload && typeof payload.setAt === "number" ? payload.setAt : Date.parse(r.ts ?? "");
        active = {
          condition,
          iterations: 0,
          setAt: Number.isFinite(setAt) ? setAt : Date.now(),
        };
        iterations = 0;
      } else if (r.kind === "goal_cleared" || r.kind === "goal_met") {
        active = undefined;
        iterations = 0;
      } else if (r.kind === "goal_not_met") {
        iterations += 1;
        const reason =
          payload && typeof (payload as { reason?: unknown }).reason === "string"
            ? (payload as { reason: string }).reason
            : undefined;
        if (active && reason !== undefined) active.lastReason = reason;
      }
      continue;
    }
    if (r.type === "attachment") {
      const att = r.attachment as Record<string, unknown> | null;
      if (!att || att.type !== "goal_status") continue;
      const condition = typeof att.condition === "string" ? att.condition : null;
      if (condition === null) continue;
      if (att.met === true || att.cleared === true) {
        active = undefined;
        iterations = 0;
      }
      if (att.met === false) {
        iterations += 1;
        const reason = typeof att.reason === "string" ? att.reason : undefined;
        if (active && reason !== undefined) active.lastReason = reason;
      }
    }
  }
  if (active === undefined) return undefined;
  active.iterations = iterations;
  goalsBySession.set(sessionId, active);
  return active;
}

export function _isGoalEventRecord(r: unknown): r is GoalEventRecord {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return rec.type === "hook_event" && typeof rec.kind === "string" && rec.kind.startsWith("goal_");
}
