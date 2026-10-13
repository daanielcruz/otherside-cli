import { forgetDeliveredLoopInstructions } from "@/engine/background/loop/autonomous.ts";
import { findModel } from "@/engine/model/catalog.ts";
import type { AgentDeps } from "@/engine/queue/runtime/turn/types.ts";
import { groupByApiRound } from "@/engine/session/compact/grouping.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import {
  configuredCompactWindow,
  modelAutoCompactTrigger,
} from "@/engine/session/compact/index.ts";
import {
  countTokensWithEstimates,
  hasAuthoritativeUsage,
  type UsageSnapshot,
} from "@/engine/session/compact/token-count.ts";
import { restampSessionTitles, sessionPathForCwd } from "@/engine/session/index.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { ContextRoom, RequestContext } from "@/kernel/std/types/request.ts";

/**
 * What every compaction does once its boundary is on disk: session titles restamp,
 * and anything delivered only into the discarded history is delivered again.
 */
export function afterCompactionBoundary(session: AgentDeps["session"]): void {
  void restampSessionTitles(sessionPathForCwd(session.storageCwd, session.id)).catch(() => {});
  forgetDeliveredLoopInstructions();
}

// Consecutive summarization failures that pause auto-compaction until the
// breaker re-arms. Auto-compaction is the only bound on session.messages
// growth, so the pause is never permanent for the session.
export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

export interface CompactState {
  rapidRefillBreakerOpen: boolean;
  rapidRefillCount: number;
  consecutiveCompactFailures: number;
  turnsSinceLast: number;
  lastAutoCompactAttemptTurnId: string | null;
}

export interface CompactOrchestrationDeps {
  agentDeps: AgentDeps;
  state: CompactState;
  turnId: string | null;
  activeAbortController(): AbortController | null;
  setActiveAbortController(ctrl: AbortController | null): void;
  injections: InjectionQueue;
  makeCtx(): RequestContext;
  clearNestedMemory?: () => void;
}

export function computeUsedContextTokens(
  messages: readonly Message[],
  lastUsage: UsageSnapshot | null,
  provider: ProviderId,
  model: string,
): number {
  const messageTokens = countTokensWithEstimates(messages, lastUsage);
  if (hasAuthoritativeUsage(messages, lastUsage)) return messageTokens;
  return messageTokens + estimateHarnessTokens(provider, model);
}

export function resolveCompactWindow(model: { contextWindow: number }): number {
  return configuredCompactWindow(model.contextWindow).window;
}

/**
 * The room one round of tool calls has before the conversation compacts: the
 * conversation's size is read when asked, and reads that lift their size limit
 * claim what they added so later reads in the same round see it.
 */
export function contextRoomFor(
  messages: readonly Message[],
  lastUsage: () => UsageSnapshot | null,
  ctx: Pick<RequestContext, "provider" | "model">,
): ContextRoom | undefined {
  const model = findModel(ctx);
  if (model === undefined) return undefined;
  const threshold = modelAutoCompactTrigger({
    model,
    window: resolveCompactWindow(model),
    provider: ctx.provider,
  });
  let claimed = 0;
  return {
    threshold,
    used: () => computeUsedContextTokens(messages, lastUsage(), ctx.provider, ctx.model) + claimed,
    claim: (tokens) => {
      claimed += tokens;
    },
  };
}

export function splitPreservedTail(
  messages: Message[],
  preserveCount = 1,
): {
  toSummarize: Message[];
  preservedTail: Message[];
} {
  const groups = groupByApiRound(messages);
  if (groups.length < 2) return { toSummarize: messages, preservedTail: [] };
  const splitAt = Math.max(1, groups.length - preserveCount);
  const summarize = groups.slice(0, splitAt).flat();
  if (!summarize.some((message) => message.role === "assistant")) {
    return { toSummarize: messages, preservedTail: [] };
  }
  return { toSummarize: summarize, preservedTail: groups.slice(splitAt).flat() };
}

export function findLastAssistantTs(messages: { role: string; ts?: number }[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.ts === "number") return m.ts;
  }
  return null;
}
