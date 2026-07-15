import { roughTokenCountEstimationForMessages } from "@/engine/session/compact/token-count.ts";
import type { Message } from "@/kernel/std/types/message.ts";

export function tokensForGroup(group: Message[]): number {
  return roughTokenCountEstimationForMessages(group);
}

export function peelStepCount(
  groupTokens: number[],
  summarizeGroupCount: number,
  tokenGap: number,
): number {
  let acc = 0;
  let steps = 0;
  for (let i = summarizeGroupCount - 1; i >= 0; i--) {
    acc += groupTokens[i] ?? 0;
    steps++;
    if (acc >= tokenGap) break;
  }
  if (steps >= summarizeGroupCount - 1) {
    return Math.max(1, Math.floor(summarizeGroupCount / 2));
  }
  return steps;
}

export function computePeelStep(
  tokenGap: number | undefined,
  groupTokens: number[],
  summarizeGroupCount: number,
): number {
  if (tokenGap === undefined) return 1;
  return peelStepCount(groupTokens, summarizeGroupCount, tokenGap);
}

export function zeroAssistantUsage(message: Message): Message {
  if (message.role !== "assistant" || !message.usage) return message;
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
