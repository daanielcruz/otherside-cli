import { listProviderConfigs } from "@/engine/contract/registry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTO_COMPACT_BUFFER_TOKENS = 13_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

export const MIN_AUTO_COMPACT_WINDOW = 100_000;
export const MAX_AUTO_COMPACT_WINDOW = 1_000_000;

export const RAPID_REFILL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE = `Autocompact is thrashing: the context refilled to the limit within ${RAPID_REFILL_TURN_THRESHOLD} turns of the previous compact, ${MAX_CONSECUTIVE_RAPID_REFILLS} times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use a tool that returns a summary.`;

export function maxOutputTokensForModel(model: string): number {
  for (const config of listProviderConfigs()) {
    for (const entry of config.models ?? []) {
      if (entry.id === model && entry.maxTokens > 0) return entry.maxTokens;
    }
  }
  return MAX_OUTPUT_TOKENS_FOR_SUMMARY;
}

export function parseTokenShorthand(raw: string): number | "auto" | undefined {
  const text = raw.trim().toLowerCase();
  if (text === "auto") return "auto";
  let value: number;
  if (text.endsWith("m")) {
    value = Number.parseFloat(text) * 1_000_000;
  } else if (text.endsWith("k")) {
    value = Number.parseFloat(text) * 1_000;
  } else {
    const parsed = Number.parseInt(text, 10);
    value = parsed >= 100 && parsed <= 1000 ? parsed * 1000 : parsed;
  }
  if (
    !Number.isFinite(value) ||
    value < MIN_AUTO_COMPACT_WINDOW ||
    value > MAX_AUTO_COMPACT_WINDOW
  ) {
    return undefined;
  }
  return Math.round(value);
}

export type AutoCompactWindowSource = "env" | "settings" | "auto";

export interface AutoCompactWindowResult {
  window: number;
  configured: number;
  source: AutoCompactWindowSource;
}

export function resolveAutoCompactWindow(
  modelWindow: number,
  settingsWindow?: number,
): AutoCompactWindowResult {
  const envRaw = process.env.OTHERSIDE_AUTO_COMPACT_WINDOW;
  if (envRaw) {
    const parsed = parseTokenShorthand(envRaw);
    if (parsed !== undefined && parsed !== "auto") {
      const configured = Math.max(MIN_AUTO_COMPACT_WINDOW, parsed);
      return { window: Math.min(modelWindow, configured), configured, source: "env" };
    }
  }
  if (settingsWindow !== undefined) {
    return {
      window: Math.min(modelWindow, settingsWindow),
      configured: settingsWindow,
      source: "settings",
    };
  }
  return { window: modelWindow, configured: modelWindow, source: "auto" };
}

export function getEffectiveContextWindowSize(
  contextWindow: number,
  maxOutputTokens = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
): number {
  const reserved = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  return contextWindow - reserved;
}

function bufferEnvOverride(): number | null {
  const envOverride = process.env.OTHERSIDE_AUTOCOMPACT_BUFFER_TOKENS;
  if (!envOverride) return null;
  const parsed = Number.parseInt(envOverride, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function percentEnvOverride(): number | null {
  const envOverride = process.env.OTHERSIDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (!envOverride) return null;
  const parsed = Number.parseFloat(envOverride);
  return Number.isNaN(parsed) || parsed <= 0 || parsed > 100 ? null : parsed;
}

function baseAutoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens);
  const bufferEnv = bufferEnvOverride();
  if (bufferEnv !== null) return effective - bufferEnv;
  return effective - AUTO_COMPACT_BUFFER_TOKENS;
}

export function getAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens: number = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  _provider?: ProviderId,
): number {
  const base = baseAutoCompactThreshold(contextWindow, maxOutputTokens);
  const percentOverride = percentEnvOverride();
  if (percentOverride === null) return base;
  const effective = getEffectiveContextWindowSize(contextWindow, maxOutputTokens);
  return Math.min(Math.floor(effective * (percentOverride / 100)), base);
}

export interface ModelAutoCompactThresholdInput {
  model: {
    contextWindow: number;
    autoCompactTokenLimit?: number;
  };
  window?: number;
  maxOutputTokens?: number;
  provider?: ProviderId;
}

export function getModelAutoCompactThreshold(input: ModelAutoCompactThresholdInput): number {
  const window = input.window ?? input.model.contextWindow;
  const fallback = getAutoCompactThreshold(window, input.maxOutputTokens, input.provider);
  const modelLimit = input.model.autoCompactTokenLimit;
  if (modelLimit === undefined) return fallback;
  const hasExplicitOverride =
    window !== input.model.contextWindow ||
    bufferEnvOverride() !== null ||
    percentEnvOverride() !== null;
  return hasExplicitOverride ? Math.min(modelLimit, fallback) : modelLimit;
}

export interface ModelBlockingLimitInput {
  model: {
    contextWindow: number;
    autoCompactTokenLimit?: number;
  };
  window?: number;
  maxOutputTokens?: number;
}

// The hard pre-send ceiling: unlike the auto-compact threshold (which leaves
// room to summarize before the window fills), this is the point past which a
// request cannot be sent at all. Same window arithmetic as the threshold
// above, with the smaller manual-compact buffer instead of the auto-compact one.
export function getModelBlockingLimit(input: ModelBlockingLimitInput): number {
  const window = input.window ?? input.model.contextWindow;
  return (
    getEffectiveContextWindowSize(window, input.maxOutputTokens) - MANUAL_COMPACT_BUFFER_TOKENS
  );
}

export function computeCompactMargin(
  contextWindow: number,
  maxOutputTokens = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  provider?: ProviderId,
): number {
  return contextWindow - getAutoCompactThreshold(contextWindow, maxOutputTokens, provider);
}

export function shouldCompact(
  usedTokens: number,
  contextWindow: number,
  maxOutputTokens = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  provider?: ProviderId,
): boolean {
  return usedTokens >= getAutoCompactThreshold(contextWindow, maxOutputTokens, provider);
}
