import { endDynamicLoop, scheduleLoopWakeup } from "@/engine/background/loop/dynamic.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import ScheduleWakeupSchema from "@/harness/tools/ScheduleWakeup/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  delaySeconds?: unknown;
  reason?: unknown;
  prompt?: unknown;
  stop?: unknown;
  noop?: unknown;
}

// A stopped loop has no next tick to tell the user how it ended.
const OUTCOME_THEN_END =
  "Then write the loop's outcome for the user as ordinary visible response text — and end the turn.";

function err(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message, is_error: true };
}

function result(toolUseId: string, content: string): ToolResult {
  return { tool_use_id: toolUseId, content };
}

function stopResult(toolUseId: string, cancelledWakeups: number): ToolResult {
  if (cancelledWakeups === 0) {
    return result(
      toolUseId,
      `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with CronDelete. ${OUTCOME_THEN_END}`,
    );
  }
  return result(
    toolUseId,
    `Loop stopped — cancelled ${cancelledWakeups} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${OUTCOME_THEN_END}`,
  );
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
    if (args.stop === true) return stopResult(call.id, endDynamicLoop());
    if (args.delaySeconds === undefined || args.reason === undefined) {
      return err(call.id, "`delaySeconds` and `reason` are required when `stop` is not true.");
    }
    if (args.prompt === undefined) {
      return err(call.id, "`prompt` is required when `stop` is not true.");
    }
    if (args.noop === undefined) {
      return err(call.id, "`noop` is required when `stop` is not true.");
    }
    if (typeof args.delaySeconds !== "number") {
      return err(call.id, "`delaySeconds` must be a number");
    }
    if (typeof args.reason !== "string") return err(call.id, "`reason` must be a string");
    if (typeof args.prompt !== "string") return err(call.id, "`prompt` must be a string");
    if (typeof args.noop !== "boolean") return err(call.id, "`noop` must be a boolean");

    const wakeup = scheduleLoopWakeup(args.delaySeconds, args.prompt, { reason: args.reason });
    if (wakeup === null) {
      return result(
        call.id,
        `Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue. ${OUTCOME_THEN_END}`,
      );
    }
    const at = new Date(wakeup.scheduledFor).toTimeString().slice(0, 8);
    const inSeconds = Math.max(0, Math.round((wakeup.scheduledFor - Date.now()) / 1000));
    const clamped = wakeup.wasClamped
      ? ` (clamped to ${wakeup.clampedDelaySeconds}s from your requested value)`
      : "";
    return result(
      call.id,
      `Next wakeup scheduled for ${at} (in ${inSeconds}s)${clamped}. If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`,
    );
  },
};
