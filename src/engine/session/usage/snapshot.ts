export interface ContextUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function mergeContextUsageSnapshot(
  previous: ContextUsageSnapshot,
  event: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheCreationInputTokens?: number | undefined;
    cacheReadInputTokens?: number | undefined;
  },
): ContextUsageSnapshot {
  return {
    inputTokens: event.inputTokens ?? previous.inputTokens,
    outputTokens: event.outputTokens ?? previous.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens ?? previous.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens ?? previous.cacheReadInputTokens,
  };
}

export function contextUsageTotal(
  usage: Pick<
    ContextUsageSnapshot,
    "inputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens"
  >,
): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}
