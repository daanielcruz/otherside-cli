import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const IMAGE_BLOCK_TOKEN_ESTIMATE = 2_000;

export function estimateTokensFromChars(content: string, bytesPerToken = 4): number {
  return Math.round(content.length / bytesPerToken);
}

export function bytesPerTokenByExtension(fileExtension: string): number {
  switch (fileExtension) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    default:
      return 4;
  }
}

export function estimateFileTokens(content: string, fileExtension: string): number {
  return estimateTokensFromChars(content, bytesPerTokenByExtension(fileExtension));
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

const RESULT_CHARS_PER_TOKEN = 3;

export function estimateToolResultTokens(content: ContentBlock & { type: "tool_result" }): number {
  const body = content.content;
  if (typeof body === "string") {
    return estimateTokensFromChars(body, RESULT_CHARS_PER_TOKEN);
  }
  let total = 0;
  for (const block of body) {
    if (block.type === "text") {
      total += estimateTokensFromChars(block.text, RESULT_CHARS_PER_TOKEN);
    } else if (block.type === "image") {
      total += IMAGE_BLOCK_TOKEN_ESTIMATE;
    }
  }
  return total;
}

function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokensFromChars(block.text);
    case "thinking":
      return estimateTokensFromChars(block.text);
    case "image":
      return IMAGE_BLOCK_TOKEN_ESTIMATE;
    case "tool_use":
      return estimateTokensFromChars(block.name + safeJsonStringify(block.input));
    case "tool_result":
      return estimateToolResultTokens(block);
  }
}

export function estimateConversationTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      total += estimateBlockTokens(block);
    }
  }
  return total;
}

export function sumUsageTokens(usage: UsageSnapshot): number {
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens
  );
}

export function totalInputTokensFromUsage(usage: UsageSnapshot): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

export function getAuthoritativeUsage(
  messages: readonly Message[],
  lastUsage: UsageSnapshot | null | undefined,
): UsageSnapshot | null {
  const lastWithUsage = findLastMessageWithUsage(messages);
  if (lastWithUsage >= 0) {
    const usage = messages[lastWithUsage]?.usage;
    if (usage && sumUsageTokens(usage) > 0) return usage;
  }
  if (lastUsage && sumUsageTokens(lastUsage) > 0) return lastUsage;
  return null;
}

export function countTokensWithEstimates(
  messages: readonly Message[],
  lastUsage: UsageSnapshot | null | undefined,
): number {
  const lastWithUsage = findLastMessageWithUsage(messages);
  if (lastWithUsage >= 0) {
    const usage = messages[lastWithUsage]?.usage;
    if (usage && sumUsageTokens(usage) > 0) {
      return sumUsageTokens(usage) + estimateConversationTokens(messages.slice(lastWithUsage + 1));
    }
  }
  if (lastUsage && sumUsageTokens(lastUsage) > 0) {
    const lastAssistantIdx = findLastAssistantIndex(messages);
    return lastAssistantIdx >= 0
      ? sumUsageTokens(lastUsage) + estimateConversationTokens(messages.slice(lastAssistantIdx + 1))
      : sumUsageTokens(lastUsage);
  }
  return estimateConversationTokens(messages);
}

export function hasAuthoritativeUsage(
  messages: readonly Message[],
  lastUsage: UsageSnapshot | null | undefined,
): boolean {
  return getAuthoritativeUsage(messages, lastUsage) !== null;
}

function findLastMessageWithUsage(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.usage) return i;
  }
  return -1;
}

function findLastAssistantIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

export function estimateTokens(messages: { content: ContentBlock[] }[]): number {
  let chars = 0;
  let imageTokens = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_result") chars += block.content.length;
      else if (block.type === "thinking") chars += block.text.length;
      else if (block.type === "tool_use") chars += JSON.stringify(block.input).length;
      else if (block.type === "image") imageTokens += IMAGE_BLOCK_TOKEN_ESTIMATE;
    }
  }
  return Math.ceil(chars / 4) + imageTokens;
}
