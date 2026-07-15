import type { SlashCommand } from "@/commands/catalog.ts";
import type { PendingChange, SlashContext, SlashResult } from "@/commands/types.ts";
import { runGoal } from "@/engine/queue/runtime.ts";

export function handleGoal(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const result = runGoal(ctx.session.id, args, { records: ctx.session.records });
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
