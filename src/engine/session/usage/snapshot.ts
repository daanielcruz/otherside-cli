import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import {
  countTokensWithEstimates,
  estimateConversationTokens,
  getAuthoritativeUsage,
} from "@/engine/session/compact/token-count.ts";
import type { Message, MessageUsageSnapshot } from "@/kernel/std/types/message.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export type ContextUsageSnapshot = Omit<MessageUsageSnapshot, "thoughtTokens">;

export function mergeContextUsageSnapshot(
  previous: ContextUsageSnapshot,
  event: Partial<ContextUsageSnapshot>,
): ContextUsageSnapshot {
  const contextTokens =
    event.contextTokens !== undefined ? event.contextTokens : previous.contextTokens;
  return {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    inputTokens: event.inputTokens ?? previous.inputTokens,
    outputTokens: event.outputTokens ?? previous.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens ?? previous.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens ?? previous.cacheReadInputTokens,
  };
}

export function contextSnapshotWithEstimates(
  snapshot: ContextUsageSnapshot,
  context: ProviderModelRoute & {
    messages?: readonly Message[] | undefined;
    fallbackContextTokens?: number;
  },
): number | undefined {
  if (snapshot.contextTokens === undefined) return undefined;
  const messages = context.messages ?? [];
  if (snapshot.contextTokens === null) {
    const estimatedMessages = context.messages
      ? estimateConversationTokens(messages)
      : (context.fallbackContextTokens ?? 0);
    return estimatedMessages + estimateHarnessTokens(context.provider, context.model);
  }
  // A live event can precede its committed message. Only add the tail once the
  // transcript carries this snapshot, not an older inference's context.
  return getAuthoritativeUsage(messages, null)?.contextTokens === snapshot.contextTokens
    ? countTokensWithEstimates(messages, snapshot)
    : snapshot.contextTokens;
}

export function contextUsageTotal(
  usage: Pick<
    ContextUsageSnapshot,
    "inputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens" | "contextTokens"
  >,
): number | null {
  return usage.contextTokens !== undefined
    ? usage.contextTokens
    : usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}
