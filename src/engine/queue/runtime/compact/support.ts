import { groupByApiRound } from "@/engine/session/compact/grouping.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { resolveAutoCompactWindow } from "@/engine/session/compact/index.ts";
import {
  hasAuthoritativeUsage,
  tokenCountWithEstimation,
  type UsageSnapshot,
} from "@/engine/session/compact/token-count.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { AgentDeps } from "../turn/types.ts";

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
  messages: Message[],
  lastUsage: UsageSnapshot | null,
  provider: ProviderId,
  model: string,
): number {
  const messageTokens = tokenCountWithEstimation(messages, lastUsage);
  if (hasAuthoritativeUsage(messages, lastUsage)) return messageTokens;
  return messageTokens + estimateHarnessTokens(provider, model);
}

export function resolveCompactWindow(model: { contextWindow: number }): number {
  return resolveAutoCompactWindow(model.contextWindow).window;
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
