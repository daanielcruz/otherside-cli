import * as cron from "@/engine/background/cron/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { CronCreateSchema } from "@/engine/tools/dynamic/CronCreate.ts";
import CronDeleteSchema from "@/harness/tools/CronDelete/tool.json" with { type: "json" };
import CronListSchema from "@/harness/tools/CronList/tool.json" with { type: "json" };
import { errorMessage } from "@/kernel/std/errno.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface CronCreateInput {
  cron?: unknown;
  prompt?: unknown;
  recurring?: unknown;
  durable?: unknown;
}

interface CronDeleteInput {
  id?: unknown;
}

const LIST_PROMPT_CHARS = 80;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, content: string): ToolResult {
  return { tool_use_id: toolUseId, content };
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return fallback;
}

export const CronCreate: ToolHandler = {
  schema: {
    name: CronCreateSchema.name,
    description: CronCreateSchema.description,
    inputSchema: CronCreateSchema.inputSchema,
  },
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as CronCreateInput;
    const cronExpr = typeof args.cron === "string" ? args.cron : null;
    const prompt = typeof args.prompt === "string" ? args.prompt : null;
    if (!cronExpr) return err(call.id, "`cron` is required");
    if (!prompt) return err(call.id, "`prompt` is required");
    const recurring = asBool(args.recurring, true);
    const durable = asBool(args.durable, false);

    const validation = cron.validateCreate({ cron: cronExpr });
    if (validation) return err(call.id, validation.message);

    let task: cron.ScheduledTask;
    try {
      task = cron.create({ cron: cronExpr, prompt, recurring, durable });
    } catch (error) {
      return err(
        call.id,
        `Could not save the task to ${cron.savedSchedulePath()}: ${errorMessage(error)}`,
      );
    }
    const schedule = cron.cronToHuman(task.cron);
    const storage = task.durable
      ? `Persisted to ${cron.SAVED_SCHEDULE_FILE}`
      : "Session-only (not written to disk, dies when otherside exits)";
    return {
      tool_use_id: call.id,
      content: task.recurring
        ? `Scheduled recurring job ${task.id} (${schedule}). ${storage}. Auto-expires after ${cron.DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${task.id} (${schedule}). ${storage}. It will fire once then auto-delete.`,
      // A resumed conversation restores its session-only tasks from this.
      meta: {
        kind: "scheduled_task",
        id: task.id,
        recurring: task.recurring,
        durable: task.durable,
      },
    };
  },
};

export const CronList: ToolHandler = {
  schema: {
    name: CronListSchema.name,
    description: CronListSchema.description,
    inputSchema: CronListSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const jobs = cron.list();
    if (jobs.length === 0) return ok(call.id, "No scheduled jobs.");
    const lines = jobs.map(
      (job) =>
        `${job.id} — ${job.humanSchedule}${job.recurring ? " (recurring)" : " (one-shot)"}${job.durable === false ? " [session-only]" : ""}: ${truncateEllipsis(oneLine(job.prompt), LIST_PROMPT_CHARS)}`,
    );
    return ok(call.id, lines.join("\n"));
  },
};

export const CronDelete: ToolHandler = {
  schema: {
    name: CronDeleteSchema.name,
    description: CronDeleteSchema.description,
    inputSchema: CronDeleteSchema.inputSchema,
  },
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as CronDeleteInput;
    const id = typeof args.id === "string" ? args.id : null;
    if (!id) return err(call.id, "`id` is required");
    let deleted: boolean;
    try {
      deleted = cron.remove(id);
    } catch (error) {
      return err(call.id, `Could not update ${cron.savedSchedulePath()}: ${errorMessage(error)}`);
    }
    if (!deleted) return err(call.id, `No scheduled job with id '${id}'`);
    return ok(call.id, `Cancelled job ${id}.`);
  },
};
