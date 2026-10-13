import { resolveFirePrompt } from "@/engine/background/loop/autonomous.ts";
import { noteLoopWakeupFired } from "@/engine/background/loop/dynamic.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { isProcessAlive } from "@/kernel/std/proc/process-alive.ts";
import * as cron from "./index.ts";
import { claimSchedulerLease, holdsSchedulerLease, releaseSchedulerLease } from "./lease.ts";
import { firstFireMs, hasAgedOut, missedOneShots, nextRecurringFireMs } from "./timing.ts";

const CHECK_INTERVAL_MS = 1_000;
const LEASE_PROBE_INTERVAL_MS = 5_000;

// When each task fires next, computed the first time this process sees it.
const nextFireAt = new Map<string, number>();
// Tasks that fired their last time but the saved schedule has not let go of yet.
const spent = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
// Whether the session is doing something a fire must wait for. Turns are always
// visible here; the host adds what only it sees, like a compaction or a skill fork.
let sessionBusy = (): boolean => emitQueue.isTurnActive();
let nextLeaseProbeAt = 0;

/** Claims the scheduler lease now and then while the project has durable tasks. */
function probeLease(saved: readonly cron.ScheduledTask[], now: number): void {
  if (saved.length === 0 || now < nextLeaseProbeAt) return;
  nextLeaseProbeAt = now + LEASE_PROBE_INTERVAL_MS;
  claimSchedulerLease();
}

/**
 * Whether this process fires a task: its own session's, the durable ones it saved,
 * and — while it holds the lease — durable ones whose saving process is gone.
 */
function firesHere(task: cron.ScheduledTask): boolean {
  if (!task.durable || task.ownerPid === process.pid) return true;
  if (!holdsSchedulerLease()) return false;
  return task.ownerPid === undefined || !isProcessAlive(task.ownerPid);
}

/** A write to the saved schedule, which another session can hold up; a failed one is skipped. */
function attempt(write: () => void): boolean {
  try {
    write();
    return true;
  } catch {
    return false;
  }
}

/** Drops a task that fired its last time; one still saved is dropped again on the next check. */
function retire(id: string): void {
  if (attempt(() => cron.remove(id))) spent.delete(id);
  else spent.add(id);
}

/** Queues a prompt as a turn the model reads but the transcript does not show as typed. */
function deliver(text: string, replayKey: string, scheduledFire?: "loop" | "task"): void {
  emitQueue.emit({
    class: "idle_prompt",
    target: "both",
    payload: {
      kind: "user_interrupt_message",
      text,
      ...(scheduledFire !== undefined ? { scheduledFire } : {}),
    },
    autoTurn: true,
    replayKey,
  });
}

function fire(task: cron.ScheduledTask, now: number): void {
  if (task.kind === "loop") noteLoopWakeupFired(task.prompt);
  deliver(
    resolveFirePrompt(task.prompt, process.cwd()),
    `scheduled:${task.id}:${now}`,
    task.kind === "loop" ? "loop" : "task",
  );
}

/**
 * Fires every task that is due. Nothing fires while the session is busy: the fire
 * waits for it to go idle, so a busy session gets one fire, not one per missed tick,
 * and the prompt is worked out against the conversation it will actually join.
 */
function check(now: number): void {
  if (cron.isSchedulingDisabled() || sessionBusy()) return;
  const all = cron.tasks();
  probeLease(
    all.filter((task) => task.durable),
    now,
  );
  const live = new Set<string>();
  for (const task of all) {
    // Re-anchored from the saved state if this process takes the task over later.
    if (!firesHere(task)) continue;
    live.add(task.id);
    if (spent.has(task.id)) {
      retire(task.id);
      continue;
    }
    let due = nextFireAt.get(task.id);
    if (due === undefined) {
      due = firstFireMs(task) ?? Number.POSITIVE_INFINITY;
      nextFireAt.set(task.id, due);
    }
    if (now < due) continue;
    fire(task, now);
    if (task.recurring && !hasAgedOut(task, now)) {
      // From now, not from the missed moment: a long-blocked session catches up once.
      nextFireAt.set(
        task.id,
        nextRecurringFireMs(task.cron, now, task.id) ?? Number.POSITIVE_INFINITY,
      );
      if (task.durable) attempt(() => cron.markFired(task.id, now));
    } else {
      nextFireAt.delete(task.id);
      retire(task.id);
    }
  }
  for (const id of nextFireAt.keys()) if (!live.has(id)) nextFireAt.delete(id);
  for (const id of spent) if (!live.has(id)) spent.delete(id);
}

function fence(prompt: string): string {
  const longestRun = Math.max(0, ...(prompt.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * The notice for saved one-shot tasks whose moment passed while otherside was closed.
 * The prompts sit in fences behind the instruction to ask first, so a task written as
 * an imperative is not taken as an order to act now.
 */
export function missedTaskNotice(missed: readonly cron.ScheduledTask[]): string {
  const plural = missed.length > 1;
  const header =
    `The following one-shot scheduled task${plural ? "s were" : " was"} missed while otherside was not running. ` +
    `${plural ? "They have" : "It has"} already been removed from the saved schedule.\n\n` +
    `Do NOT execute ${plural ? "these prompts" : "this prompt"} yet. ` +
    `First use the AskUserQuestion tool to ask whether to run ${plural ? "each one" : "it"} now. ` +
    "Only execute if the user confirms.";
  const blocks = missed.map((task) => {
    const meta = `[${cron.cronToHuman(task.cron)}, created ${new Date(task.createdAt).toLocaleString()}]`;
    const marks = fence(task.prompt);
    return `${meta}\n${marks}\n${task.prompt}\n${marks}`;
  });
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function surfaceMissedOneShots(now: number): void {
  const all = cron.tasks();
  probeLease(
    all.filter((task) => task.durable),
    now,
  );
  const missed = missedOneShots(all, now).filter(firesHere);
  if (missed.length === 0) return;
  for (const task of missed) retire(task.id);
  deliver(missedTaskNotice(missed), `scheduled:missed:${now}`);
}

/** Starts firing due tasks; `isBusy` adds what keeps the session busy besides a turn. */
export function startCronScheduler(options: { isBusy?: () => boolean } = {}): () => void {
  if (timer !== null || cron.isSchedulingDisabled()) return stopCronScheduler;
  const { isBusy } = options;
  if (isBusy !== undefined) sessionBusy = () => emitQueue.isTurnActive() || isBusy();
  surfaceMissedOneShots(Date.now());
  timer = setInterval(() => check(Date.now()), CHECK_INTERVAL_MS);
  return stopCronScheduler;
}

export function stopCronScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  sessionBusy = () => emitQueue.isTurnActive();
  nextFireAt.clear();
  spent.clear();
  nextLeaseProbeAt = 0;
  releaseSchedulerLease();
}

export function checkScheduledTasksForTests(now: number): void {
  check(now);
}
