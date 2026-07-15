import * as cron from "@/engine/background/cron/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { CronCreateSchema } from "@/engine/tools/dynamic/CronCreate.ts";
import CronDeleteSchema from "@/harness/tools/CronDelete/tool.json" with { type: "json" };
import CronListSchema from "@/harness/tools/CronList/tool.json" with { type: "json" };
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

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
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

    const validation = cron.validateCreate({ cron: cronExpr, durable });
    if (validation) return err(call.id, validation.message);

    const out = cron.create({ cron: cronExpr, prompt, recurring, durable });
    return ok(call.id, out);
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
    return ok(call.id, { jobs });
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
    const deleted = cron.remove(id);
    if (!deleted) return err(call.id, `No scheduled job with id '${id}'`);
    return ok(call.id, { id });
  },
};
