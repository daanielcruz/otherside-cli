import * as cron from "@/engine/background/cron/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ScheduleWakeupSchema from "@/harness/tools/ScheduleWakeup/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  delaySeconds?: unknown;
  reason?: unknown;
  prompt?: unknown;
}

interface LoopChain {
  startedAt: number;
  lastScheduledFor: number;
  agedOut?: boolean;
}

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
const MAX_CHAIN_AGE_MS = cron.DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const loopChains = new Map<string, LoopChain>();

function err(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message, is_error: true };
}

function roundToNextMinute(timestampMs: number): number {
  const target = new Date(timestampMs);
  if (target.getSeconds() > 0 || target.getMilliseconds() > 0) {
    target.setMinutes(target.getMinutes() + 1);
  }
  target.setSeconds(0, 0);
  return target.getTime();
}

function cronFor(timestampMs: number): string {
  const target = new Date(timestampMs);
  return `${target.getMinutes()} ${target.getHours()} * * *`;
}

function removePendingLoopWakeups(): void {
  for (const job of cron.list()) {
    if (job.kind === "loop") cron.remove(job.id);
  }
}

function formatResult(
  toolUseId: string,
  scheduledFor: number,
  clampedDelaySeconds: number,
  wasClamped: boolean,
): ToolResult {
  if (scheduledFor === 0) {
    return {
      tool_use_id: toolUseId,
      content:
        "Wakeup not scheduled. Either the /loop dynamic runtime gate is off or the loop reached its maximum duration — the loop has ended; do not re-issue.",
    };
  }
  const hhmmss = new Date(scheduledFor).toTimeString().slice(0, 8);
  const secondsFromNow = Math.max(0, Math.round((scheduledFor - Date.now()) / 1000));
  const clampedNote = wasClamped
    ? ` (clamped to ${clampedDelaySeconds}s from your requested value)`
    : "";
  return {
    tool_use_id: toolUseId,
    content: `Next wakeup scheduled for ${hhmmss} (in ${secondsFromNow}s)${clampedNote}.`,
  };
}

export const ScheduleWakeup: ToolHandler = {
  schema: {
    name: ScheduleWakeupSchema.name,
    description: ScheduleWakeupSchema.description,
    inputSchema: ScheduleWakeupSchema.inputSchema,
  },
  render: {
    isTransparent: () => true,
  },
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    if (typeof args.delaySeconds !== "number" || !Number.isFinite(args.delaySeconds)) {
      return err(call.id, "`delaySeconds` must be a finite number");
    }
    if (typeof args.reason !== "string") return err(call.id, "`reason` must be a string");
    if (typeof args.prompt !== "string") return err(call.id, "`prompt` must be a string");

    const requested = Math.round(args.delaySeconds);
    const clampedDelaySeconds = Math.max(MIN_DELAY_SECONDS, Math.min(MAX_DELAY_SECONDS, requested));
    const wasClamped = requested !== clampedDelaySeconds;
    const now = Date.now();
    const scheduledFor = roundToNextMinute(now + clampedDelaySeconds * 1000);

    removePendingLoopWakeups();
    const prior = loopChains.get(args.prompt);
    const expired = prior !== undefined && now > prior.lastScheduledFor + MAX_DELAY_SECONDS * 1000;
    const startedAt = prior === undefined || expired ? now : prior.startedAt;
    if (now - startedAt >= MAX_CHAIN_AGE_MS) {
      loopChains.set(args.prompt, {
        startedAt,
        lastScheduledFor: now,
        agedOut: true,
      });
      return formatResult(call.id, 0, 0, false);
    }

    cron.create({
      cron: cronFor(scheduledFor),
      prompt: args.prompt,
      recurring: false,
      durable: false,
      kind: "loop",
      // Keep the exact target because a minute-only cron expression also matches
      // the same clock time on earlier days.
      scheduledFor,
    });
    loopChains.set(args.prompt, { startedAt, lastScheduledFor: scheduledFor });
    return formatResult(call.id, scheduledFor, clampedDelaySeconds, wasClamped);
  },
};

export function _resetScheduleWakeupForTests(): void {
  loopChains.clear();
}
