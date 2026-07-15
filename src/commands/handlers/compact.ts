import type { SlashCommand } from "@/commands/catalog.ts";
import { isAbortMessage, type SlashContext, type SlashResult } from "@/commands/types.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";

function buildCompactEventHandler(ctx: SlashContext): ((ev: ProviderEvent) => void) | undefined {
  const { onCompactRetry, onCompactProgress } = ctx;
  if (!onCompactRetry && !onCompactProgress) return undefined;
  return (ev) => {
    if (ev.kind === "retry_status" && onCompactRetry) {
      onCompactRetry(ev.attempt, ev.maxAttempts, ev.delayMs, ev.reason);
    }
    if (ev.kind === "text_delta" && onCompactProgress) {
      onCompactProgress(ev.text.length);
    }
  };
}

export async function handleCompact(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  try {
    const customInstructions = args.length > 0 ? args : undefined;
    const onEvent = buildCompactEventHandler(ctx);
    type ForceOpts = NonNullable<Parameters<typeof ctx.agent.forceCompact>[0]>;
    const opts: ForceOpts = {};
    if (customInstructions !== undefined) opts.customInstructions = customInstructions;
    if (onEvent) opts.onEvent = onEvent;
    if (ctx.onCompactStart) opts.onCompactStart = ctx.onCompactStart;
    if (ctx.onCompactDone) opts.onCompactDone = ctx.onCompactDone;
    const { dropped, summary, durationMs, truncated } = await ctx.agent.forceCompact(opts);
    if (dropped > 0) {
      ctx.onCompactSucceeded?.(dropped, durationMs, truncated, summary);
      return { kind: "anchor", command: cmd };
    }
    return { kind: "anchor", command: cmd, feedback: "Not enough messages to compact." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbortMessage(msg)) {
      return {
        kind: "anchor",
        command: cmd,
        restoreInput: `/${cmd.name}${args.length > 0 ? ` ${args}` : ""}`,
      };
    }
    return { kind: "anchor", command: cmd };
  }
}
