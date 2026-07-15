import { emitQueue } from "@/engine/queue/emit.ts";
import { getIsScrollDraining } from "@/kernel/std/state/scroll-activity.ts";
import {
  DEFAULT_MAX_AGE_DAYS,
  get as getJob,
  list as listJobs,
  remove as removeJob,
} from "./index.ts";
import { computeNextCronRun, parseCronExpression } from "./parser.ts";

export interface InjectionSink {
  pushInjection(text: string): void;
}

const TICK_INTERVAL_MS = 30_000;
const ONE_SHOT_EARLY_GRACE_MS = 90_000;
const MAX_AGE_MS = DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

const lastFireAt = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function jitterFor(cronExpr: string, isRecurring: boolean): number {
  const parts = cronExpr.trim().split(/\s+/);
  const minute = parts[0];
  if (!isRecurring && (minute === "0" || minute === "30")) {
    return -Math.floor(Math.random() * ONE_SHOT_EARLY_GRACE_MS);
  }
  if (isRecurring) {
    return Math.floor(Math.random() * Math.min(15 * 60_000, 60_000));
  }
  return 0;
}

function tick(sink: InjectionSink): void {
  const now = Date.now();
  for (const job of listJobs()) {
    const fields = parseCronExpression(job.cron);
    if (!fields) continue;
    const recurring = job.recurring === true;
    const last = lastFireAt.get(job.id) ?? 0;
    let targetMs = job.scheduledFor;
    if (targetMs === undefined) {
      const baseFrom = new Date(Math.max(last, now - 24 * 60 * 60 * 1000));
      const next = computeNextCronRun(fields, baseFrom);
      if (!next) continue;
      targetMs = next.getTime() + jitterFor(job.cron, recurring);
    }
    if (now < targetMs) continue;
    lastFireAt.set(job.id, now);
    if (job.kind === "loop") {
      emitQueue.emit({
        class: "urgent_output",
        target: "both",
        payload: { kind: "user_interrupt_message", text: job.prompt },
        autoTurn: true,
        replayKey: `loop:${job.id}`,
      });
    } else {
      sink.pushInjection(`[scheduled task ${job.id}: ${job.humanSchedule}]\n${job.prompt}`);
    }
    if (!recurring) {
      removeJob(job.id);
      lastFireAt.delete(job.id);
      continue;
    }
    if (now - last > MAX_AGE_MS && last > 0) {
      removeJob(job.id);
      lastFireAt.delete(job.id);
    }
  }
}

function surfaceMissedOneShots(sink: InjectionSink): void {
  const now = Date.now();
  const missed: { id: string; cron: string; humanSchedule: string; prompt: string }[] = [];
  for (const job of listJobs()) {
    const fields = parseCronExpression(job.cron);
    if (!fields) continue;
    const recurring = job.recurring === true;
    if (recurring) continue;
    const full = getJob(job.id);
    if (!full?.durable) continue;
    const next = computeNextCronRun(fields, new Date(full.createdAt));
    if (!next) continue;
    if (next.getTime() < now) {
      missed.push({
        id: job.id,
        cron: job.cron,
        humanSchedule: job.humanSchedule,
        prompt: job.prompt,
      });
    }
  }
  if (missed.length === 0) return;
  const lines = missed.map(
    (m) => `- ${m.id} (${m.humanSchedule}) — was due before this session started: ${m.prompt}`,
  );
  sink.pushInjection(
    `[catch-up: ${missed.length} one-shot durable cron task${missed.length === 1 ? "" : "s"} missed while otherside was closed]\n${lines.join("\n")}`,
  );
  for (const m of missed) {
    removeJob(m.id);
    lastFireAt.delete(m.id);
  }
}

export function startCronScheduler(sink: InjectionSink): () => void {
  if (timer !== null) return stopCronScheduler;
  surfaceMissedOneShots(sink);
  timer = setInterval(() => {
    if (getIsScrollDraining()) return;
    tick(sink);
  }, TICK_INTERVAL_MS);
  return stopCronScheduler;
}

export function stopCronScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function _testTick(sink: InjectionSink): void {
  tick(sink);
}
