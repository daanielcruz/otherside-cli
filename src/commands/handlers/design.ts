import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { setPendingBrief } from "@/design/pending-brief.ts";

const RESERVED_VERBS = new Set(["close", "stop", "rotate", "restart"]);

export function handleDesign(cmd: SlashCommand, args: string, ctx: SlashContext): SlashResult {
  const brief = args.trim();
  if (brief.length > 0 && !RESERVED_VERBS.has(brief.toLowerCase())) {
    setPendingBrief(ctx.session.id, brief);
  }
  ctx.openOverlay("design");
  return { kind: "panel", command: cmd };
}
