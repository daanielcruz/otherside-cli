import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const IMAGE_BLOCK_TOKEN_ESTIMATE = 2_000;

export function roughTokenCountEstimation(content: string, bytesPerToken = 4): number {
  return Math.round(content.length / bytesPerToken);
}

export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case "json":
    case "jsonl":
    case "jsonc":
      return 2;
    default:
      return 4;
  }
}

export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(fileExtension));
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

const TOOL_RESULT_BYTES_PER_TOKEN = 3;

export function roughTokenCountEstimationForToolResult(
  content: ContentBlock & { type: "tool_result" },
): number {
  const body = content.content;
  if (typeof body === "string") {
    return roughTokenCountEstimation(body, TOOL_RESULT_BYTES_PER_TOKEN);
  }
  let total = 0;
  for (const block of body) {
    if (block.type === "text") {
      total += roughTokenCountEstimation(block.text, TOOL_RESULT_BYTES_PER_TOKEN);
    } else if (block.type === "image") {
      total += IMAGE_BLOCK_TOKEN_ESTIMATE;
    }
  }
  return total;
}

function roughTokenCountEstimationForBlock(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return roughTokenCountEstimation(block.text);
    case "thinking":
      return roughTokenCountEstimation(block.text);
    case "image":
      return IMAGE_BLOCK_TOKEN_ESTIMATE;
    case "tool_use":
      return roughTokenCountEstimation(block.name + safeJsonStringify(block.input));
    case "tool_result":
      return roughTokenCountEstimationForToolResult(block);
  }
}

export function roughTokenCountEstimationForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      total += roughTokenCountEstimationForBlock(block);
    }
  }
  return total;
}

export function getTokenCountFromUsage(usage: UsageSnapshot): number {
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
    if (usage && getTokenCountFromUsage(usage) > 0) return usage;
  }
  if (lastUsage && getTokenCountFromUsage(lastUsage) > 0) return lastUsage;
  return null;
}

export function tokenCountWithEstimation(
  messages: readonly Message[],
  lastUsage: UsageSnapshot | null | undefined,
): number {
  const lastWithUsage = findLastMessageWithUsage(messages);
  if (lastWithUsage >= 0) {
    const usage = messages[lastWithUsage]?.usage;
    if (usage && getTokenCountFromUsage(usage) > 0) {
      return (
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(messages.slice(lastWithUsage + 1))
      );
    }
  }
  if (lastUsage && getTokenCountFromUsage(lastUsage) > 0) {
    const lastAssistantIdx = findLastAssistantIndex(messages);
    return lastAssistantIdx >= 0
      ? getTokenCountFromUsage(lastUsage) +
          roughTokenCountEstimationForMessages(messages.slice(lastAssistantIdx + 1))
      : getTokenCountFromUsage(lastUsage);
  }
  return roughTokenCountEstimationForMessages(messages);
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
