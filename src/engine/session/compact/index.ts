import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export const COMPACT_SUMMARY_TOKEN_RESERVE = 20_000;
export const AUTO_COMPACT_TOKEN_HEADROOM = 13_000;
export const BLOCKING_COMPACT_TOKEN_HEADROOM = 3_000;

export const COMPACT_WINDOW_MINIMUM = 100_000;
export const COMPACT_WINDOW_MAXIMUM = 1_000_000;

export const RAPID_REFILL_TURN_SPAN = 3;
export const RAPID_REFILL_STREAK_LIMIT = 3;
export const RAPID_REFILL_FAILURE_TEXT = `Autocompact is thrashing: the context refilled to the limit within ${RAPID_REFILL_TURN_SPAN} turns of the previous compact, ${RAPID_REFILL_STREAK_LIMIT} times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use a tool that returns a summary.`;

export function providerCompactOutputLimit(route: ProviderModelRoute): number {
  const registeredModel = getProviderConfig(route.provider)?.models?.find(
    ({ id }) => id === route.model,
  );
  const declaredLimit = registeredModel?.maxTokens;
  return declaredLimit !== undefined && declaredLimit > 0
    ? declaredLimit
    : COMPACT_SUMMARY_TOKEN_RESERVE;
}

function applyBareNumberScale(value: number): number {
  const usesThousands = value >= 100 && value <= 1000;
  return usesThousands ? value * 1_000 : value;
}

export function readCompactWindowValue(input: string): number | "auto" | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized === "auto") return "auto";

  const suffix = normalized.at(-1);
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : undefined;
  const parsed = multiplier
    ? Number.parseFloat(normalized) * multiplier
    : applyBareNumberScale(Number.parseInt(normalized, 10));
  const withinPolicyRange =
    Number.isFinite(parsed) && parsed >= COMPACT_WINDOW_MINIMUM && parsed <= COMPACT_WINDOW_MAXIMUM;
  return withinPolicyRange ? Math.round(parsed) : undefined;
}

export type CompactWindowSource = "env" | "settings" | "auto";

export interface ResolvedCompactWindow {
  window: number;
  configured: number;
  source: CompactWindowSource;
}

export function configuredCompactWindow(
  modelCapacity: number,
  savedWindow?: number,
): ResolvedCompactWindow {
  const envValue = process.env.OTHERSIDE_AUTO_COMPACT_WINDOW;
  const requestedByEnv = envValue ? readCompactWindowValue(envValue) : undefined;
  if (typeof requestedByEnv === "number") {
    const configured = Math.max(COMPACT_WINDOW_MINIMUM, requestedByEnv);
    return {
      window: Math.min(modelCapacity, configured),
      configured,
      source: "env",
    };
  }

  if (savedWindow !== undefined) {
    return {
      window: Math.min(modelCapacity, savedWindow),
      configured: savedWindow,
      source: "settings",
    };
  }

  return { window: modelCapacity, configured: modelCapacity, source: "auto" };
}

export function availableCompactTokens(
  windowSize: number,
  outputAllowance = COMPACT_SUMMARY_TOKEN_RESERVE,
): number {
  return windowSize - Math.min(outputAllowance, COMPACT_SUMMARY_TOKEN_RESERVE);
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function validPercentageEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) || value <= 0 || value > 100 ? undefined : value;
}

interface CompactThresholdOverrides {
  headroom: number | undefined;
  percentage: number | undefined;
}

function readThresholdOverrides(): CompactThresholdOverrides {
  return {
    headroom: positiveIntegerEnv("OTHERSIDE_AUTOCOMPACT_BUFFER_TOKENS"),
    percentage: validPercentageEnv("OTHERSIDE_AUTOCOMPACT_PCT_OVERRIDE"),
  };
}

function thresholdFromBudget(usableTokens: number, overrides: CompactThresholdOverrides): number {
  const headroom = overrides.headroom ?? AUTO_COMPACT_TOKEN_HEADROOM;
  const triggerAfterHeadroom = usableTokens - headroom;
  if (overrides.percentage === undefined) return triggerAfterHeadroom;
  const triggerAtShare = Math.floor(usableTokens * (overrides.percentage / 100));
  return Math.min(triggerAfterHeadroom, triggerAtShare);
}

export function autoCompactTrigger(
  windowSize: number,
  outputAllowance: number = COMPACT_SUMMARY_TOKEN_RESERVE,
  _provider?: ProviderId,
): number {
  const usableTokens = availableCompactTokens(windowSize, outputAllowance);
  return thresholdFromBudget(usableTokens, readThresholdOverrides());
}

export interface ModelCompactTriggerRequest {
  model: {
    contextWindow: number;
    autoCompactTokenLimit?: number;
  };
  window?: number;
  maxOutputTokens?: number;
  provider?: ProviderId;
}

export function modelAutoCompactTrigger(request: ModelCompactTriggerRequest): number {
  const resolvedWindow = request.window ?? request.model.contextWindow;
  const overrides = readThresholdOverrides();
  const policyTrigger = thresholdFromBudget(
    availableCompactTokens(resolvedWindow, request.maxOutputTokens),
    overrides,
  );
  const declaredTrigger = request.model.autoCompactTokenLimit;
  if (declaredTrigger === undefined) return policyTrigger;

  const policyWasExplicit =
    resolvedWindow !== request.model.contextWindow ||
    overrides.headroom !== undefined ||
    overrides.percentage !== undefined;
  return policyWasExplicit ? Math.min(declaredTrigger, policyTrigger) : declaredTrigger;
}

export interface ModelBlockingCeilingRequest {
  model: {
    contextWindow: number;
    autoCompactTokenLimit?: number;
  };
  window?: number;
  maxOutputTokens?: number;
}

export function modelBlockingCeiling(request: ModelBlockingCeilingRequest): number {
  const resolvedWindow = request.window ?? request.model.contextWindow;
  const usableTokens = availableCompactTokens(resolvedWindow, request.maxOutputTokens);
  return usableTokens - BLOCKING_COMPACT_TOKEN_HEADROOM;
}

export function compactTriggerMargin(
  windowSize: number,
  outputAllowance = COMPACT_SUMMARY_TOKEN_RESERVE,
  provider?: ProviderId,
): number {
  return windowSize - autoCompactTrigger(windowSize, outputAllowance, provider);
}

export function contextAtCompactTrigger(
  consumedTokens: number,
  windowSize: number,
  outputAllowance = COMPACT_SUMMARY_TOKEN_RESERVE,
  provider?: ProviderId,
): boolean {
  const trigger = autoCompactTrigger(windowSize, outputAllowance, provider);
  return consumedTokens >= trigger;
}
