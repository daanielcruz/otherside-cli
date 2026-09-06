import type { SlashCommand } from "@/commands/catalog.ts";
import type { PendingChange, SlashContext, SlashResult } from "@/commands/types.ts";
import { runGoal } from "@/engine/queue/runtime.ts";
import { appendRecord, goalStatusAttachment, nowIso } from "@/engine/session/index.ts";

export async function handleGoal(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const result = runGoal(ctx.session.id, args, { records: ctx.session.records });
  if (result.event) {
    await appendRecord(ctx.session, {
      type: "attachment",
      ts: nowIso(),
      attachment: goalStatusAttachment(result.event.condition, {
        met: result.event.kind !== "goal_set",
      }),
    });
  }
  const change: PendingChange = {
    kind: "set_goal",
    condition: result.event?.condition ?? args,
    ...(result.metaMessage ? { metaMessage: result.metaMessage } : {}),
  };
  return {
    kind: "anchor",
    command: cmd,
    feedback: result.feedback,
    ...(result.event ? { goalEvent: result.event } : {}),
    pendingChange: change,
  };
}
