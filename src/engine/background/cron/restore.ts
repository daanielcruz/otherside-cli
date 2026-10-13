import type { SessionRecord } from "@/engine/session/record/index.ts";
import CronCreateSchema from "@/harness/tools/CronCreate/tool.json" with { type: "json" };
import CronDeleteSchema from "@/harness/tools/CronDelete/tool.json" with { type: "json" };
import { isRecord } from "@/kernel/std/value-guards.ts";
import * as cron from "./index.ts";
import { nextOneShotFireMs, RECURRING_MAX_AGE_MS } from "./timing.ts";

interface CreatedTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
}

function stillDue(task: CreatedTask, now: number): boolean {
  if (task.recurring) return now - task.createdAt < RECURRING_MAX_AGE_MS;
  const fireAt = nextOneShotFireMs(task.cron, task.createdAt, task.id);
  return fireAt !== null && fireAt >= now;
}

function createdTasks(records: readonly SessionRecord[]): {
  created: CreatedTask[];
  cancelled: Set<string>;
} {
  const calls = new Map<string, { cron: string; prompt: string }>();
  const created: CreatedTask[] = [];
  const cancelled = new Set<string>();
  for (const record of records) {
    if ("isSidechain" in record && record.isSidechain === true) continue;
    if (record.type === "tool_call") {
      const args = record.args;
      if (!isRecord(args)) continue;
      if (record.tool_name === CronCreateSchema.name) {
        if (typeof args.cron === "string" && typeof args.prompt === "string") {
          calls.set(record.call_id, { cron: args.cron, prompt: args.prompt });
        }
      } else if (record.tool_name === CronDeleteSchema.name && typeof args.id === "string") {
        cancelled.add(args.id);
      }
      continue;
    }
    if (record.type !== "tool_result" || record.is_error) continue;
    const call = calls.get(record.call_id);
    const meta: unknown = record.meta;
    if (call === undefined || !isRecord(meta) || meta.kind !== "scheduled_task") continue;
    const { id, recurring, durable } = meta;
    const createdAt = Date.parse(record.ts);
    if (typeof id !== "string" || typeof recurring !== "boolean") continue;
    if (typeof durable !== "boolean" || Number.isNaN(createdAt)) continue;
    created.push({ ...call, id, recurring, durable, createdAt });
  }
  return { created, cancelled };
}

/**
 * Re-arms the session-only tasks a resumed conversation created and never cancelled.
 * A durable task is still saved for the project; a recurring task past its age limit,
 * and a one-shot whose moment passed, stay gone. Returns how many were re-armed.
 */
export function restoreSessionTasks(records: readonly SessionRecord[], now = Date.now()): number {
  if (cron.isSchedulingDisabled()) return 0;
  const { created, cancelled } = createdTasks(records);
  const live = new Set(cron.tasks().map((task) => task.id));
  let restored = 0;
  for (const task of created) {
    if (task.durable || cancelled.has(task.id) || live.has(task.id)) continue;
    if (!stillDue(task, now)) continue;
    cron.create({
      id: task.id,
      cron: task.cron,
      prompt: task.prompt,
      recurring: task.recurring,
      durable: false,
      createdAt: task.createdAt,
    });
    live.add(task.id);
    restored += 1;
  }
  return restored;
}
