import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { computeNextCronRun, cronToHuman, parseCronExpression } from "./parser.ts";

export const MAX_JOBS = 50;
export const DEFAULT_MAX_AGE_DAYS = 7;

/** The project file durable tasks are saved in, relative to the project. */
export const SAVED_SCHEDULE_FILE = ".otherside/scheduled_tasks.json";

/** Scheduling is switched off for this process: no cron tool is offered and nothing fires. */
export function isSchedulingDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_CRON);
}

export interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  /** The process that saved a durable task; it fires the task while it runs. */
  ownerPid?: number;
  kind?: "loop";
  /** The exact moment a /loop wakeup fires; its minute-only cron also matches earlier days. */
  scheduledFor?: number;
  /** Why the model picked a /loop wakeup's delay. */
  reason?: string;
  /** A /loop wakeup the runtime armed because the model did not schedule one. */
  keepalive?: true;
}

export interface ListJob {
  id: string;
  cron: string;
  humanSchedule: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  kind?: "loop";
  scheduledFor?: number;
}

interface SavedTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring?: true;
  lastFiredAt?: number;
  ownerPid?: number;
}

interface SavedRead {
  path: string;
  mtimeMs: number;
  size: number;
  tasks: readonly ScheduledTask[];
}

const sessionStore = new Map<string, ScheduledTask>();
let savedRead: SavedRead | null = null;
let projectRootForTests: string | null = null;

// otherside never changes its working directory, so this stays the project it was launched in.
function projectRoot(): string {
  return projectRootForTests ?? process.cwd();
}

/** Where the project's durable tasks live; every session opened in the project shares them. */
export function savedSchedulePath(): string {
  return join(projectRoot(), SAVED_SCHEDULE_FILE);
}

function fromSaved(entry: unknown): ScheduledTask | null {
  if (!isRecord(entry)) return null;
  const { id, cron, prompt, createdAt, recurring, lastFiredAt, ownerPid } = entry;
  if (typeof id !== "string" || typeof cron !== "string" || typeof prompt !== "string") return null;
  if (typeof createdAt !== "number" || parseCronExpression(cron) === null) return null;
  return {
    id,
    cron,
    prompt,
    recurring: recurring === true,
    durable: true,
    createdAt,
    lastFiredAt: typeof lastFiredAt === "number" ? lastFiredAt : null,
    ...(typeof ownerPid === "number" ? { ownerPid } : {}),
  };
}

function toSaved(task: ScheduledTask): SavedTask {
  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    createdAt: task.createdAt,
    ...(task.recurring ? { recurring: true } : {}),
    ...(task.lastFiredAt !== null ? { lastFiredAt: task.lastFiredAt } : {}),
    ...(task.ownerPid !== undefined ? { ownerPid: task.ownerPid } : {}),
  };
}

function parseSaved(raw: string): ScheduledTask[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks.map(fromSaved).filter((task) => task !== null);
  } catch {
    return [];
  }
}

/**
 * The project's durable tasks as the file holds them now. Another session may have
 * changed the file, so it is read again whenever it changed since the last read.
 */
function savedTasks(): readonly ScheduledTask[] {
  const path = savedSchedulePath();
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    savedRead = null;
    return [];
  }
  if (
    savedRead?.path === path &&
    savedRead.mtimeMs === stat.mtimeMs &&
    savedRead.size === stat.size
  ) {
    return savedRead.tasks;
  }
  let tasks: ScheduledTask[] = [];
  try {
    tasks = parseSaved(readFileSync(path, "utf8"));
  } catch {}
  savedRead = { path, mtimeMs: stat.mtimeMs, size: stat.size, tasks };
  return tasks;
}

/** Rewrites the durable tasks under the file's lock, from what the file holds at that moment. */
function updateSaved(change: (tasks: ScheduledTask[]) => ScheduledTask[] | null): void {
  const path = savedSchedulePath();
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(path, () => {
    savedRead = null;
    const next = change(savedTasks().map((task) => ({ ...task })));
    if (next === null) return;
    atomicWriteFileSync(path, `${JSON.stringify({ tasks: next.map(toSaved) }, null, 2)}\n`);
    savedRead = null;
  });
}

/** Every task, durable and session-only, in creation order. */
export function tasks(): ScheduledTask[] {
  return [...savedTasks(), ...sessionStore.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Eight hex digits: short enough to read back, and a stable seed for the task's jitter. */
function newTaskId(): string {
  const taken = new Set(tasks().map((task) => task.id));
  let id: string;
  do {
    id = Math.floor(Math.random() * 0xffff_ffff)
      .toString(16)
      .padStart(8, "0");
  } while (taken.has(id));
  return id;
}

export interface ValidationError {
  message: string;
  errorCode: number;
}

export function validateCreate(input: { cron: string }): ValidationError | null {
  const fields = parseCronExpression(input.cron);
  if (!fields) {
    return {
      message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
      errorCode: 1,
    };
  }
  if (computeNextCronRun(fields, new Date()) === null) {
    return {
      message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
      errorCode: 2,
    };
  }
  if (tasks().length >= MAX_JOBS) {
    return {
      message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
      errorCode: 3,
    };
  }
  return null;
}

/** Adds a task. A durable one is saved for the project, and saving it can throw. */
export function create(input: {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  kind?: "loop";
  scheduledFor?: number;
  reason?: string;
  keepalive?: true;
  createdAt?: number;
  /** The id a task restored from a resumed conversation keeps. */
  id?: string;
}): ScheduledTask {
  const durable = input.durable ?? false;
  const task: ScheduledTask = {
    id: input.id ?? newTaskId(),
    cron: input.cron,
    prompt: input.prompt,
    recurring: input.recurring ?? true,
    durable,
    createdAt: input.createdAt ?? Date.now(),
    lastFiredAt: null,
    ...(durable ? { ownerPid: process.pid } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.keepalive !== undefined ? { keepalive: input.keepalive } : {}),
  };
  if (durable) updateSaved((saved) => [...saved, task]);
  else sessionStore.set(task.id, task);
  return task;
}

export function list(): ListJob[] {
  return tasks().map((task) => ({
    id: task.id,
    cron: task.cron,
    humanSchedule: cronToHuman(task.cron),
    prompt: task.prompt,
    ...(task.recurring ? { recurring: true } : {}),
    ...(task.durable ? {} : { durable: false }),
    ...(task.kind !== undefined ? { kind: task.kind } : {}),
    ...(task.scheduledFor !== undefined ? { scheduledFor: task.scheduledFor } : {}),
  }));
}

export function get(id: string): ScheduledTask | undefined {
  return sessionStore.get(id) ?? savedTasks().find((task) => task.id === id);
}

export function remove(id: string): boolean {
  return removeMany([id]) > 0;
}

export function removeMany(ids: readonly string[]): number {
  let removed = 0;
  const remaining = new Set<string>();
  for (const id of ids) {
    if (sessionStore.delete(id)) removed += 1;
    else remaining.add(id);
  }
  if (remaining.size === 0 || !savedTasks().some((task) => remaining.has(task.id))) return removed;
  updateSaved((saved) => {
    const kept = saved.filter((task) => !remaining.has(task.id));
    removed += saved.length - kept.length;
    return kept.length === saved.length ? null : kept;
  });
  return removed;
}

/** Records a durable recurring task's fire, so a restart schedules its next fire from there. */
export function markFired(id: string, at: number): void {
  updateSaved((saved) => {
    const task = saved.find((entry) => entry.id === id);
    if (task === undefined) return null;
    task.lastFiredAt = at;
    return saved;
  });
}

/** Points the durable store at a scratch project, or back at the real one with null; forgets session tasks. */
export function useProjectRootForTests(root: string | null): void {
  projectRootForTests = root;
  savedRead = null;
  sessionStore.clear();
}

export { computeNextCronRun, cronToHuman, parseCronExpression };
