import type { ProviderEvent } from "@/kernel/std/types/events.ts";

export function usageEvent(
  inputTokens?: number,
  outputTokens?: number,
  thoughtTokens?: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number,
): ProviderEvent | null {
  const event: ProviderEvent = { kind: "usage" };
  if (validToken(inputTokens)) event.inputTokens = inputTokens;
  if (validToken(outputTokens)) event.outputTokens = outputTokens;
  if (validToken(thoughtTokens)) event.thoughtTokens = thoughtTokens;
  if (validToken(cacheCreationInputTokens))
    event.cacheCreationInputTokens = cacheCreationInputTokens;
  if (validToken(cacheReadInputTokens)) event.cacheReadInputTokens = cacheReadInputTokens;
  return event.inputTokens !== undefined ||
    event.outputTokens !== undefined ||
    event.thoughtTokens !== undefined ||
    event.cacheCreationInputTokens !== undefined ||
    event.cacheReadInputTokens !== undefined
    ? event
    : null;
}

export function usageFromAnthropic(value: unknown): ProviderEvent | null {
  const obj = objectValue(value);
  if (!obj) return null;
  return usageEvent(
    numberValue(obj.input_tokens),
    numberValue(obj.output_tokens),
    undefined,
    numberValue(obj.cache_creation_input_tokens),
    numberValue(obj.cache_read_input_tokens),
  );
}

export function usageFromOpenAi(value: unknown): ProviderEvent | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const outputDetails = objectValue(obj.output_tokens_details ?? obj.completion_tokens_details);
  const inputDetails = objectValue(obj.input_tokens_details ?? obj.prompt_tokens_details);
  const cachedTop = numberValue(obj.cached_input_tokens);
  const cachedNested = numberValue(inputDetails?.cached_tokens);
  const cached = cachedTop !== undefined ? cachedTop : cachedNested;
  const totalInput = numberValue(obj.input_tokens ?? obj.prompt_tokens);
  const freshInput =
    totalInput !== undefined && cached !== undefined
      ? Math.max(0, totalInput - cached)
      : totalInput;
  return usageEvent(
    freshInput,
    numberValue(obj.output_tokens ?? obj.completion_tokens),
    numberValue(outputDetails?.reasoning_tokens),
    undefined,
    cached,
  );
}

export function usageFromGemini(value: unknown): ProviderEvent | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const prompt = numberValue(obj.promptTokenCount);
  const cached = numberValue(obj.cachedContentTokenCount);
  const input =
    prompt !== undefined && cached !== undefined ? Math.max(0, prompt - cached) : prompt;
  const cacheRead = prompt !== undefined ? (cached ?? 0) : cached;
  return usageEvent(
    input,
    numberValue(obj.candidatesTokenCount),
    numberValue(obj.thoughtTokenCount ?? obj.thoughtsTokenCount),
    undefined,
    cacheRead,
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function validToken(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
