import { listRunning as listRunningTasks } from "@/engine/background/tasks/background.ts";
import { escapeXml } from "@/engine/background/tasks/notification.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  type ActiveGoal,
  type GoalDeferral,
  getActiveGoal,
  setGoalDeferral,
  setGoalIdleCheckIns,
} from "@/engine/queue/state.ts";

// A goal check-in is a notification that wakes the session to keep working on
// its goal. It is sent after a turn ended before the goal could be judged, and
// while background work keeps holding the goal's check back: once the wait
// passes the check-in interval, then at doubling intervals, with at most three
// sent to an idle session before the user writes again.

/** Background work that holds the goal's check back until it finishes. */
export interface DeferringWork {
  id: string;
  kind: "subagent" | "shell" | "workflow";
  description: string;
  startedAt: number;
}

export interface GoalCheckIn {
  summary: string;
  body: string;
}

const DEFAULT_CHECK_IN_MINUTES = 30;
/** The interval doubles with each check-in of a wait, up to four times its length. */
const MAX_BACKOFF_STEPS = 2;
const MIN_CHECK_IN_DELAY_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const IDLE_CHECK_IN_CAP = 3;
const WORK_LINE_CHARS = 120;
const GOAL_CHECK_IN_REPLAY_KEY = "goal-check-in";
const IDLE_PAUSE_SUMMARY = " · idle check-ins paused until your next message";
const IDLE_PAUSE_BODY =
  " The session won't wake for another check-in until the user sends a message, so say clearly where things stand.";

const idleTimerBySession = new Map<string, ReturnType<typeof setTimeout>>();

/** The check-in interval; zero turns check-ins, retries and pause notices off. */
export function goalCheckInIntervalMs(): number {
  const raw = process.env.OTHERSIDE_GOAL_CHECKIN_MINUTES;
  const minutes = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_CHECK_IN_MINUTES) * 60_000;
}

export function goalCheckInQueued(): boolean {
  return emitQueue.peek().some((item) => item.replayKey === GOAL_CHECK_IN_REPLAY_KEY);
}

/** A check-in reaches the model as a notification and wakes an idle session. */
export function deliverGoalCheckIn({ summary, body }: GoalCheckIn): void {
  emitQueue.emit({
    class: "urgent_output",
    target: "both",
    payload: {
      kind: "task_notification_xml",
      text: `<task-notification>\n<summary>${escapeXml(summary)}</summary>\n</task-notification>\n<system-reminder>\n${body}\n</system-reminder>`,
      summary,
    },
    autoTurn: true,
    replayKey: GOAL_CHECK_IN_REPLAY_KEY,
  });
}

export function goalCheckInLead(condition: string): string {
  return `Goal check-in: «${escapeXml(singleLineText(condition))}»`;
}

export function isSameGoal(goal: ActiveGoal | undefined, other: ActiveGoal): goal is ActiveGoal {
  return goal !== undefined && goal.setAt === other.setAt && goal.condition === other.condition;
}

/** Live background work this session owns. */
export function sessionDeferringWork(sessionId: string): DeferringWork[] {
  const tasks: DeferringWork[] = listRunningTasks()
    .filter((task) => task.sessionId === sessionId)
    .map((task) => ({
      id: task.id,
      kind: task.kind === "shell" ? "shell" : "subagent",
      description:
        (task.kind === "shell" ? task.command : task.description) ??
        task.description ??
        task.agentName,
      startedAt: task.startedAt,
    }));
  const workflows: DeferringWork[] = listWorkflowTasks()
    .filter((task) => task.sessionId === sessionId && task.status === "running")
    .map((task) => ({
      id: task.id,
      kind: "workflow",
      description: task.description,
      startedAt: task.startedAt,
    }));
  return [...tasks, ...workflows];
}

/**
 * Notes that the goal's check was held back at the end of a turn. Returns the
 * check-in to continue the turn with once the wait has run past its interval.
 */
export function holdGoalCheck(
  sessionId: string,
  goal: ActiveGoal,
  work: readonly DeferringWork[],
  now: number,
): string | undefined {
  const interval = goalCheckInIntervalMs();
  if (interval === 0) return undefined;
  const wait = currentWait(goal, work, now, interval);
  const waited = now - wait.since;
  if (waited < checkInDueAfter(interval, wait.checkIns)) {
    setGoalDeferral(sessionId, { since: wait.since, checkIns: wait.checkIns, lastPassAt: now });
    return undefined;
  }
  setGoalDeferral(sessionId, { since: now, checkIns: wait.checkIns + 1, lastPassAt: now });
  return backgroundWorkCheckIn(goal.condition, waited, work).body;
}

/** No background work holds the check back any more. */
export function releaseGoalCheck(sessionId: string): void {
  setGoalDeferral(sessionId, undefined);
}

/** Wakes an idle session when its held-back goal is due a check-in. */
export function armGoalIdleCheckIn(sessionId: string, now: number): void {
  cancelGoalIdleCheckIn(sessionId);
  const interval = goalCheckInIntervalMs();
  const goal = getActiveGoal(sessionId);
  if (interval === 0 || goal?.deferral === undefined) return;
  const dueAfter = checkInDueAfter(interval, goal.deferral.checkIns);
  const waited = idleCheckInsSpent(goal) ? 0 : now - goal.deferral.since;
  scheduleIdleCheckIn(
    sessionId,
    goal,
    Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_CHECK_IN_DELAY_MS, dueAfter - waited)),
  );
}

export function cancelGoalIdleCheckIn(sessionId: string): void {
  const timer = idleTimerBySession.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  idleTimerBySession.delete(sessionId);
}

/** The user wrote: idle check-ins may run again. */
export function resetGoalIdleCheckIns(sessionId: string): void {
  setGoalIdleCheckIns(sessionId, undefined);
}

function scheduleIdleCheckIn(sessionId: string, armedFor: ActiveGoal, delayMs: number): void {
  const timer = setTimeout(() => fireIdleCheckIn(sessionId, armedFor), delayMs);
  (timer as { unref?: () => void }).unref?.();
  idleTimerBySession.set(sessionId, timer);
}

function fireIdleCheckIn(sessionId: string, armedFor: ActiveGoal): void {
  idleTimerBySession.delete(sessionId);
  const goal = getActiveGoal(sessionId);
  const deferral = goal?.deferral;
  if (!isSameGoal(goal, armedFor) || deferral === undefined) return;
  const interval = goalCheckInIntervalMs();
  if (interval === 0) return;
  if (idleCheckInsSpent(goal)) {
    armGoalIdleCheckIn(sessionId, Date.now());
    return;
  }
  if (emitQueue.isTurnActive() || goalCheckInQueued()) {
    scheduleIdleCheckIn(sessionId, goal, MIN_CHECK_IN_DELAY_MS);
    return;
  }
  const work = sessionDeferringWork(sessionId);
  // A finished task's notification is already waiting to wake the session.
  if (work.length === 0 && emitQueue.hasPendingAutoTurn()) {
    scheduleIdleCheckIn(sessionId, goal, MIN_CHECK_IN_DELAY_MS);
    return;
  }
  const now = Date.now();
  const wait = currentWait(goal, work, now, interval);
  if (wait.since === now) {
    setGoalDeferral(sessionId, { since: now, checkIns: 0, lastPassAt: now });
    armGoalIdleCheckIn(sessionId, now);
    return;
  }
  const idleCheckIns = (goal.idleCheckIns ?? 0) + 1;
  setGoalDeferral(sessionId, { since: now, checkIns: wait.checkIns + 1, lastPassAt: now });
  setGoalIdleCheckIns(sessionId, idleCheckIns);
  const checkIn = backgroundWorkCheckIn(goal.condition, now - wait.since, work);
  deliverGoalCheckIn(
    idleCheckIns >= IDLE_CHECK_IN_CAP
      ? { summary: checkIn.summary + IDLE_PAUSE_SUMMARY, body: checkIn.body + IDLE_PAUSE_BODY }
      : checkIn,
  );
  armGoalIdleCheckIn(sessionId, now);
}

/**
 * The wait the goal is in. Work started after the last held-back turn, once a
 * whole interval has passed since that turn, begins a new wait.
 */
function currentWait(
  goal: ActiveGoal,
  work: readonly DeferringWork[],
  now: number,
  interval: number,
): Pick<GoalDeferral, "since" | "checkIns"> {
  const deferral = goal.deferral;
  if (deferral === undefined) return { since: now, checkIns: 0 };
  const firstStart = Math.min(...work.map((item) => item.startedAt));
  const newRun =
    Number.isFinite(firstStart) &&
    firstStart > deferral.lastPassAt &&
    now - deferral.lastPassAt > interval;
  return newRun ? { since: now, checkIns: 0 } : deferral;
}

function checkInDueAfter(interval: number, checkIns: number): number {
  return interval * 2 ** Math.min(checkIns, MAX_BACKOFF_STEPS);
}

function idleCheckInsSpent(goal: ActiveGoal): boolean {
  return (goal.idleCheckIns ?? 0) >= IDLE_CHECK_IN_CAP;
}

function backgroundWorkCheckIn(
  condition: string,
  waitedMs: number,
  work: readonly DeferringWork[],
): GoalCheckIn {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  const lead = goalCheckInLead(condition);
  if (work.length === 0) {
    return {
      summary: "Goal check-in: background work no longer running",
      body: `${lead} is still active. Its evaluation was deferred for ${minutes} min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal.`,
    };
  }
  const lines = work.map((item) =>
    escapeXml(clippedLine(`- ${item.id} · ${item.kind} · ${singleLineText(item.description)}`)),
  );
  return {
    summary: "Goal check-in: background work still running",
    body: `${lead} is still active, and evaluation has been deferred for ${minutes} min because background work is still running:\n${lines.join("\n")}\nCheck on their progress (e.g. read their output). If they are progressing, say so briefly and keep waiting; if they are stuck or no longer needed, fix or stop them and continue toward the goal.`,
  };
}

function singleLineText(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clippedLine(line: string): string {
  if (line.length <= WORK_LINE_CHARS) return line;
  return `${line.slice(0, WORK_LINE_CHARS)}… [+${line.length - WORK_LINE_CHARS} chars]`;
}

export function _resetGoalCheckInsForTesting(): void {
  for (const timer of idleTimerBySession.values()) clearTimeout(timer);
  idleTimerBySession.clear();
}
