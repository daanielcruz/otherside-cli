export const MAX_GOAL_CHARS = 4000;

export interface ActiveGoal {
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
  /** Present while background work holds the goal's check back. */
  deferral?: GoalDeferral;
  /** Check-ins sent while the session sat idle since the user last wrote. */
  idleCheckIns?: number;
}

export interface GoalDeferral {
  /** When the current wait began; a check-in starts the next wait. */
  since: number;
  /** Check-ins sent during this run of background work. */
  checkIns: number;
  /** The last time a turn ended with the check held back. */
  lastPassAt: number;
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

export function setGoalDeferral(sessionId: string, deferral: GoalDeferral | undefined): void {
  const goal = goalsBySession.get(sessionId);
  if (goal === undefined) return;
  if (deferral === undefined) delete goal.deferral;
  else goal.deferral = deferral;
}

export function setGoalIdleCheckIns(sessionId: string, count: number | undefined): void {
  const goal = goalsBySession.get(sessionId);
  if (goal === undefined) return;
  if (count === undefined) delete goal.idleCheckIns;
  else goal.idleCheckIns = count;
}

export function _resetGoalsForTesting(): void {
  goalsBySession.clear();
}

interface GoalStateRecord {
  type: string;
  kind?: string;
  payload?: unknown;
  ts?: string;
  isSidechain?: boolean;
  attachment?: unknown;
}

interface GoalEventRecord extends GoalStateRecord {
  type: "hook_event";
  ts: string;
  kind: string;
  payload: unknown;
}

export function restoreGoalFromRecords(
  sessionId: string,
  records: ReadonlyArray<GoalStateRecord>,
  hookEvents: ReadonlyArray<GoalStateRecord> = [],
): ActiveGoal | undefined {
  let active: ActiveGoal | undefined;
  for (const record of goalStateRecords(records, hookEvents)) {
    if (record.isSidechain === true) continue;
    if (record.type === "hook_event") {
      active = goalFromHookEvent(record, active);
      continue;
    }
    if (record.type === "attachment") {
      active = goalFromAttachment(record, active);
    }
  }
  if (active === undefined) {
    goalsBySession.delete(sessionId);
    return undefined;
  }
  goalsBySession.set(sessionId, active);
  return active;
}

function goalStateRecords(
  records: ReadonlyArray<GoalStateRecord>,
  hookEvents: ReadonlyArray<GoalStateRecord>,
): GoalStateRecord[] {
  return [...records, ...hookEvents].filter(
    (record) => record.type === "hook_event" || record.type === "attachment",
  );
}

function goalFromHookEvent(
  record: GoalStateRecord,
  active: ActiveGoal | undefined,
): ActiveGoal | undefined {
  const payload = objectPayload(record.payload);
  const condition = typeof payload?.condition === "string" ? payload.condition : null;
  if (record.kind === "goal_set" && condition !== null) {
    return {
      condition,
      iterations: 0,
      setAt: timestampFrom(payload?.setAt, record.ts),
    };
  }
  if (record.kind === "goal_cleared" || record.kind === "goal_met") return undefined;
  if (record.kind !== "goal_not_met" || active === undefined) return active;

  active.iterations = Math.max(
    active.iterations,
    restoredIteration(payload?.iteration, active.iterations + 1),
  );
  if (typeof payload?.reason === "string") active.lastReason = payload.reason;
  return active;
}

function goalFromAttachment(
  record: GoalStateRecord,
  active: ActiveGoal | undefined,
): ActiveGoal | undefined {
  const attachment = objectPayload(record.attachment);
  if (attachment?.type !== "goal_status") return active;
  if (attachment.met === true || attachment.cleared === true || attachment.failed === true) {
    return undefined;
  }
  if (typeof attachment.condition !== "string") return undefined;

  const reason = typeof attachment.reason === "string" ? attachment.reason : undefined;
  const isSetMarker = reason === undefined && attachment.iteration === undefined;
  const next =
    active?.condition === attachment.condition && !isSetMarker
      ? active
      : {
          condition: attachment.condition,
          iterations: 0,
          setAt: timestampFrom(undefined, record.ts),
        };
  const fallbackIteration = reason === undefined ? next.iterations : next.iterations + 1;
  next.iterations = Math.max(
    next.iterations,
    restoredIteration(attachment.iteration, fallbackIteration),
  );
  if (reason !== undefined) next.lastReason = reason;
  return next;
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function timestampFrom(value: unknown, fallback: string | undefined): number {
  const timestamp = typeof value === "number" ? value : Date.parse(fallback ?? "");
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function restoredIteration(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function _isGoalEventRecord(r: unknown): r is GoalEventRecord {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  return rec.type === "hook_event" && typeof rec.kind === "string" && rec.kind.startsWith("goal_");
}
