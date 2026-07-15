import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { computeNextCronRun, cronToHuman, parseCronExpression } from "./parser.ts";

export const MAX_JOBS = 50;
export const DEFAULT_MAX_AGE_DAYS = 7;

export interface ScheduledTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  kind?: "loop";
  scheduledFor?: number;
}

export interface CreateOutput {
  id: string;
  humanSchedule: string;
  recurring: boolean;
  durable?: boolean;
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

const sessionStore = new Map<string, ScheduledTask>();
let counter = 1;
let durableLoaded = false;
const durableStore = new Map<string, ScheduledTask>();

function nextId(): string {
  const n = counter++;
  return `cron-${n.toString().padStart(4, "0")}`;
}

function durableFilePath(): string {
  return join(configRoot(), "scheduled_tasks.json");
}

function loadDurable(): void {
  if (durableLoaded) return;
  durableLoaded = true;
  const path = durableFilePath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: ScheduledTask[] };
    if (!parsed?.tasks) return;
    for (const t of parsed.tasks) {
      if (typeof t?.id !== "string") continue;
      durableStore.set(t.id, t);
      const tail = t.id.match(/cron-(\d+)/);
      if (tail) {
        const n = Number.parseInt(tail[1] ?? "", 10);
        if (Number.isFinite(n) && n >= counter) counter = n + 1;
      }
    }
  } catch {}
}

function persistDurable(): void {
  const path = durableFilePath();
  const tasks = [...durableStore.values()];
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ tasks }, null, 2));
  } catch {}
}

function allTasks(): ScheduledTask[] {
  loadDurable();
  return [...durableStore.values(), ...sessionStore.values()];
}

export interface ValidationError {
  message: string;
  errorCode: number;
}

export function validateCreate(input: { cron: string; durable: boolean }): ValidationError | null {
  const fields = parseCronExpression(input.cron);
  if (!fields) {
    return {
      message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
      errorCode: 1,
    };
  }
  const next = computeNextCronRun(fields, new Date());
  if (next === null) {
    return {
      message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
      errorCode: 2,
    };
  }
  if (allTasks().length >= MAX_JOBS) {
    return {
      message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
      errorCode: 3,
    };
  }
  return null;
}

export function create(input: {
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  kind?: "loop";
  scheduledFor?: number;
}): CreateOutput {
  loadDurable();
  const recurring = input.recurring ?? true;
  const durable = input.durable ?? false;
  const task: ScheduledTask = {
    id: nextId(),
    cron: input.cron,
    prompt: input.prompt,
    recurring,
    durable,
    createdAt: Date.now(),
    lastFiredAt: null,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
  };
  if (durable) {
    durableStore.set(task.id, task);
    persistDurable();
  } else {
    sessionStore.set(task.id, task);
  }
  const out: CreateOutput = {
    id: task.id,
    humanSchedule: cronToHuman(task.cron),
    recurring,
  };
  if (durable) out.durable = true;
  return out;
}

export function list(): ListJob[] {
  return allTasks()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => {
      const job: ListJob = {
        id: t.id,
        cron: t.cron,
        humanSchedule: cronToHuman(t.cron),
        prompt: t.prompt,
      };
      if (t.recurring) job.recurring = true;
      if (t.durable === false) job.durable = false;
      if (t.kind !== undefined) job.kind = t.kind;
      if (t.scheduledFor !== undefined) job.scheduledFor = t.scheduledFor;
      return job;
    });
}

export function remove(id: string): boolean {
  loadDurable();
  if (durableStore.delete(id)) {
    persistDurable();
    return true;
  }
  return sessionStore.delete(id);
}

export function get(id: string): ScheduledTask | undefined {
  loadDurable();
  return durableStore.get(id) ?? sessionStore.get(id);
}

export function clear(): void {
  sessionStore.clear();
  durableStore.clear();
  durableLoaded = false;
  counter = 1;
}

export function parseInterval(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)\s*([a-z]*)$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] ?? "").toLowerCase().trim();
  const factor: Record<string, number> = {
    "": 60_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    s: 1_000,
    sec: 1_000,
    secs: 1_000,
    second: 1_000,
    seconds: 1_000,
    h: 3_600_000,
    hr: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
  };
  const f = factor[unit];
  if (f === undefined) return null;
  return n * f;
}

export { computeNextCronRun, cronToHuman, parseCronExpression };
