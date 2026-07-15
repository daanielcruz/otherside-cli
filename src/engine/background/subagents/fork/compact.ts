import { findModel } from "@/engine/model/catalog.ts";
import {
  computeUsedContextTokens,
  resolveCompactWindow,
} from "@/engine/queue/runtime/compact/support.ts";
import {
  getModelAutoCompactThreshold,
  getModelBlockingLimit,
} from "@/engine/session/compact/index.ts";
import {
  applyTokenBasedMicroCompact,
  MICRO_COMPACT_CLEARED_MESSAGE,
} from "@/engine/session/compact/micro.ts";
import { summarizeConversation } from "@/engine/session/compact/summary.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { getCompactUserSummaryMessage } from "@/harness/routines/compact/index.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { SidechainRecord } from "./types.ts";

// Mirrors the main session's pre-send overflow guard (checkContextOverflow):
// a fork transcript at or past this ceiling cannot be sent, even after
// maybeCompactFork has had a chance to run, so the loop must stop instead of
// forwarding the request and taking a raw provider 400.
export function isForkOverBlockingLimit(
  fork: Message[],
  ctx: RequestContext,
  lastUsage: UsageSnapshot | null,
): boolean {
  const model = findModel(ctx.model, ctx.provider);
  if (!model) return false;
  const window = resolveCompactWindow(model);
  const limit = getModelBlockingLimit({ model, window });
  const used = computeUsedContextTokens(fork, lastUsage, ctx.provider, ctx.model);
  return used >= limit;
}

export function maybeMicroCompactFork(
  fork: Message[],
  ctx: RequestContext,
  lastUsage: UsageSnapshot | null,
  appendSidechainRecord: (record: SidechainRecord) => void,
): void {
  const model = findModel(ctx.model, ctx.provider);
  if (!model) return;
  const window = resolveCompactWindow(model);
  const threshold = getModelAutoCompactThreshold({ model, window, provider: ctx.provider });
  const usedTokens = computeUsedContextTokens(fork, lastUsage, ctx.provider, ctx.model);
  const outcome = applyTokenBasedMicroCompact({
    messages: fork,
    usedTokens,
    threshold,
  });
  if (outcome?.clearedToolUseIds) {
    for (const id of outcome.clearedToolUseIds) {
      appendSidechainRecord({
        type: "content_replacement",
        ts: nowIso(),
        kind: "tool-result",
        toolUseId: id,
        replacement: MICRO_COMPACT_CLEARED_MESSAGE,
      });
    }
  }
}

export async function maybeCompactFork(
  fork: Message[],
  ctx: RequestContext,
  lastUsage: UsageSnapshot | null,
  _declarations: ProviderToolDeclaration[],
): Promise<"skipped" | "compacted" | "failed"> {
  const model = findModel(ctx.model, ctx.provider);
  if (!model) return "skipped";
  const window = resolveCompactWindow(model);
  const autoThreshold = getModelAutoCompactThreshold({ model, window, provider: ctx.provider });
  const blockingLimit = getModelBlockingLimit({ model, window });
  const threshold = Math.min(autoThreshold, blockingLimit);
  const used = computeUsedContextTokens(fork, lastUsage, ctx.provider, ctx.model);
  if (used < threshold) return "skipped";
  try {
    const result = await summarizeConversation(ctx, fork, []);
    const summaryMessage = getCompactUserSummaryMessage(result.summary, {
      suppressFollowUpQuestions: true,
    });
    const sys = fork[0]?.role === "system" ? fork[0] : null;
    fork.length = 0;
    if (sys) fork.push(sys);
    fork.push({ role: "user", content: [{ type: "text", text: summaryMessage }] });
    return "compacted";
  } catch {
    return "failed";
  }
}
