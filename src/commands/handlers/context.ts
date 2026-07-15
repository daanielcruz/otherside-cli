import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { getContextBreakdown } from "@/engine/session/usage/context.ts";

export function handleContext(cmd: SlashCommand, _args: string, ctx: SlashContext): SlashResult {
  const state = ctx.broker.read();
  const contextUsage = getContextBreakdown({
    provider: state.provider,
    model: state.model,
    messages: ctx.session.messages,
    serverInputTokens: ctx.getServerInputTokens?.() ?? 0,
  });
  return { kind: "anchor", command: cmd, contextUsage };
}
