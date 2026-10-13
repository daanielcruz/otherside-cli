import { DEFAULT_MAX_AGE_DAYS, type ScheduledTask } from "./index.ts";
import { computeNextCronRun, parseCronExpression } from "./parser.ts";

const MINUTE_MS = 60_000;
/** How long a provider keeps a prompt prefix cached between requests. */
export const PROMPT_CACHE_TTL_MS = 5 * MINUTE_MS;
/** How far ahead of the cache expiring a fire lands, so it still reads the cached prefix. */
export const CACHE_LEAD_MS = 15_000;
export const RECURRING_MAX_AGE_MS = DEFAULT_MAX_AGE_DAYS * 24 * 60 * MINUTE_MS;

const RECURRING_JITTER_FRACTION = 0.5;
const RECURRING_JITTER_CAP_MS = 30 * MINUTE_MS;
const ONE_SHOT_LEAD_MAX_MS = 90_000;
const ONE_SHOT_ROUND_MINUTE = 30;
// Only every-N-minutes expressions have a gap that can straddle the cache TTL.
const CACHE_LEAD_ELIGIBLE = /^\*\/\d+ \* \* \* \*$/;

export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron);
  if (!fields) return null;
  return computeNextCronRun(fields, new Date(fromMs))?.getTime() ?? null;
}

/** The task id read as a fraction in [0, 1): stable across restarts, spread across sessions. */
function jitterFraction(taskId: string): number {
  const fraction = Number.parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(fraction) ? fraction : 0;
}

/**
 * A recurring task's next fire after `fromMs`, delayed by a share of the gap to the
 * fire after it so sessions sharing a cron do not all fire on the same second. A
 * gap just past the prompt-cache TTL is pulled back to land inside it instead.
 */
export function nextRecurringFireMs(cron: string, fromMs: number, taskId: string): number | null {
  const first = nextCronRunMs(cron, fromMs);
  if (first === null) return null;
  const second = nextCronRunMs(cron, first);
  if (second === null) return first;
  const gap = second - first;
  if (
    CACHE_LEAD_ELIGIBLE.test(cron) &&
    CACHE_LEAD_MS < gap &&
    gap >= PROMPT_CACHE_TTL_MS &&
    gap - CACHE_LEAD_MS < PROMPT_CACHE_TTL_MS
  ) {
    return fromMs + gap - CACHE_LEAD_MS;
  }
  const delay = Math.min(
    jitterFraction(taskId) * RECURRING_JITTER_FRACTION * gap,
    RECURRING_JITTER_CAP_MS,
  );
  return first + delay;
}

/**
 * A one-shot task's fire. A task pinned to a round half hour fires up to 90s early
 * instead: late would break "remind me at 3pm", early is invisible. Never before
 * the task existed.
 */
export function nextOneShotFireMs(cron: string, fromMs: number, taskId: string): number | null {
  const first = nextCronRunMs(cron, fromMs);
  if (first === null) return null;
  if (new Date(first).getMinutes() % ONE_SHOT_ROUND_MINUTE !== 0) return first;
  return Math.max(first - jitterFraction(taskId) * ONE_SHOT_LEAD_MAX_MS, fromMs);
}

/**
 * When a task first fires in this process: a /loop wakeup at its exact moment, a
 * recurring task after its last fire (or its creation), a one-shot after its creation.
 */
export function firstFireMs(task: ScheduledTask): number | null {
  if (task.scheduledFor !== undefined) return task.scheduledFor;
  if (task.recurring) {
    return nextRecurringFireMs(task.cron, task.lastFiredAt ?? task.createdAt, task.id);
  }
  return nextOneShotFireMs(task.cron, task.createdAt, task.id);
}

/** A recurring task this old fires one last time, then is deleted. */
export function hasAgedOut(task: ScheduledTask, nowMs: number): boolean {
  return task.recurring && nowMs - task.createdAt >= RECURRING_MAX_AGE_MS;
}

/** Saved one-shot tasks whose moment passed while nothing was running to fire them. */
export function missedOneShots(tasks: readonly ScheduledTask[], nowMs: number): ScheduledTask[] {
  return tasks.filter((task) => {
    if (task.recurring || !task.durable || task.kind === "loop") return false;
    const next = nextCronRunMs(task.cron, task.createdAt);
    return next !== null && next < nowMs;
  });
}
