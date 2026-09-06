import { estimateConversationTokens } from "@/engine/session/compact/token-count.ts";
import type { Message } from "@/kernel/std/types/message.ts";

export function countGroupTokens(messages: Message[]): number {
  return estimateConversationTokens(messages);
}

function halfOfSummaryGroups(groupCount: number): number {
  return Math.max(1, Math.floor(groupCount / 2));
}

function tailTokenTotals(tokenCounts: number[], groupCount: number): number[] {
  const tail = Array.from(
    { length: Math.max(0, groupCount) },
    (_, offset) => tokenCounts[groupCount - offset - 1] ?? 0,
  );
  let total = 0;
  return tail.map((tokens) => {
    total += tokens;
    return total;
  });
}

export function peelAdvanceForGap(tokenCounts: number[], groupCount: number, gap: number): number {
  const totals = tailTokenTotals(tokenCounts, groupCount);
  const reachedGapAt = totals.findIndex((total) => total >= gap);
  const advance = reachedGapAt === -1 ? totals.length : reachedGapAt + 1;
  const leavesOneGroup = advance >= groupCount - 1;
  return leavesOneGroup ? halfOfSummaryGroups(groupCount) : advance;
}

export function nextPeelAdvance(
  gap: number | undefined,
  tokenCounts: number[],
  groupCount: number,
): number {
  return gap === undefined ? 1 : peelAdvanceForGap(tokenCounts, groupCount, gap);
}

export function scrubCarriedAssistantUsage(message: Message): Message {
  if (message.role !== "assistant" || message.usage === undefined) return message;
  return {
    ...message,
    usage: {
      ...message.usage,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}
