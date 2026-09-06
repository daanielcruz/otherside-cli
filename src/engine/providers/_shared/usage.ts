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

/**
 * Anthropic's own API reports the fresh and cached halves of the prompt
 * disjointly, so context arithmetic adds them.
 */
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

/**
 * Anthropic-shaped endpoints that report `input_tokens` as the whole prompt,
 * with the cached counters naming a subset of it. Reduced to the fresh
 * remainder here so the context total stays the prompt size instead of
 * counting the cached prefix twice on every hit.
 */
export function usageFromAnthropicPromptTotal(value: unknown): ProviderEvent | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const cacheCreation = numberValue(obj.cache_creation_input_tokens);
  const cacheRead = numberValue(obj.cache_read_input_tokens);
  return usageEvent(
    freshInputTokens(numberValue(obj.input_tokens), (cacheCreation ?? 0) + (cacheRead ?? 0)),
    numberValue(obj.output_tokens),
    undefined,
    cacheCreation,
    cacheRead,
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
  return usageEvent(
    freshInputTokens(numberValue(obj.input_tokens ?? obj.prompt_tokens), cached),
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
  const cacheRead = prompt !== undefined ? (cached ?? 0) : cached;
  return usageEvent(
    freshInputTokens(prompt, cached),
    numberValue(obj.candidatesTokenCount),
    numberValue(obj.thoughtTokenCount ?? obj.thoughtsTokenCount),
    undefined,
    cacheRead,
  );
}

/**
 * The share of a reported prompt total the upstream did not read from cache.
 * Absent counters leave the total alone: an endpoint that reports no cache
 * figure has nothing to remove.
 */
function freshInputTokens(
  total: number | undefined,
  cached: number | undefined,
): number | undefined {
  if (total === undefined || cached === undefined) return total;
  return Math.max(0, total - cached);
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
