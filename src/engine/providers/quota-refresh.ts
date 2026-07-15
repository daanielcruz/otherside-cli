import {
  type AnthropicUsage,
  applyAnthropicUsageLimits,
  fetchAnthropicUsage,
} from "@/engine/providers/anthropic/usage.ts";
import {
  type AntigravityUsage,
  applyAntigravityQuotaWarning,
  fetchAntigravityUsage,
} from "@/engine/providers/antigravity/usage.ts";
import {
  applyCodexQuotaWarning,
  type CodexUsage,
  fetchCodexUsage,
} from "@/engine/providers/codex/usage.ts";
import { applyGlmQuotaWarning, fetchGlmUsage } from "@/engine/providers/glm/usage.ts";
import {
  applyKimiQuotaWarning,
  fetchKimiUsage,
  type KimiUsage,
} from "@/engine/providers/kimi/usage.ts";
import { applyMinimaxQuotaWarning, fetchMinimaxUsage } from "@/engine/providers/minimax/usage.ts";
import { applyXaiQuotaWarning, fetchXaiUsage } from "@/engine/providers/xai/usage.ts";
import type { PlanQuotaData } from "@/engine/session/usage/plan-quota.ts";
import { QUOTA_REFRESH_COOLDOWN_MS } from "@/engine/session/usage/quota-warning.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

/** Failure cooldown is shorter than the success cooldown so a blip can recover sooner. */
export const QUOTA_FAILURE_RETRY_COOLDOWN_MS = 60_000;

export interface QuotaRefreshMeta {
  inFlight: boolean;
  lastSuccessAtEpochMs: number | null;
  lastErrorAtEpochMs: number | null;
  lastError: string | null;
}

export type QuotaRefreshOutcome =
  | { ok: true; skipped?: "cooldown" | "unsupported" }
  | { ok: false; error: string };

type QuotaRefreshApplyOpts = { modelId?: string | undefined };

type QuotaRefresher = {
  fetch: () => Promise<unknown>;
  apply: (data: unknown, opts?: QuotaRefreshApplyOpts) => void;
};

interface ProviderRefreshMeta {
  lastSuccessAtEpochMs: number | null;
  lastErrorAtEpochMs: number | null;
  lastError: string | null;
}

const metaByProvider = new Map<ProviderId, ProviderRefreshMeta>();
const inFlightByProvider = new Map<ProviderId, Promise<QuotaRefreshOutcome>>();
const testRefreshers = new Map<ProviderId, QuotaRefresher>();

let nowFn: () => number = () => Date.now();

export function quotaRefreshMeta(provider: ProviderId): QuotaRefreshMeta {
  const meta = metaByProvider.get(provider);
  return {
    inFlight: inFlightByProvider.has(provider),
    lastSuccessAtEpochMs: meta?.lastSuccessAtEpochMs ?? null,
    lastErrorAtEpochMs: meta?.lastErrorAtEpochMs ?? null,
    lastError: meta?.lastError ?? null,
  };
}

/**
 * Single-flight, cooldown-aware quota refresh. A thrown fetch (including the
 * shared 10s AbortSignal timeout) preserves last-known-good quota state: no
 * apply/clear runs on failure.
 */
export async function refreshProviderQuota(
  provider: ProviderId,
  opts: { force?: boolean; modelId?: string } = {},
): Promise<QuotaRefreshOutcome> {
  const refresher = resolveRefresher(provider);
  if (!refresher) return { ok: true, skipped: "unsupported" };

  const existing = inFlightByProvider.get(provider);
  if (existing) return existing;

  if (!opts.force) {
    const skip = cooldownSkip(provider);
    if (skip) return skip;
  }

  const promise = runRefresh(provider, refresher, opts).finally(() => {
    inFlightByProvider.delete(provider);
  });
  inFlightByProvider.set(provider, promise);
  return promise;
}

export function setQuotaRefresherForTests(
  provider: ProviderId,
  refresher: { fetch: () => Promise<unknown>; apply: (data: unknown) => void } | null,
): void {
  if (refresher === null) testRefreshers.delete(provider);
  else testRefreshers.set(provider, refresher);
}

export function resetQuotaRefreshMetaForTests(): void {
  metaByProvider.clear();
  nowFn = () => Date.now();
}

/** Test-only clock seam for cooldown assertions without real sleeps. */
export function setQuotaRefreshNowForTests(now: (() => number) | null): void {
  nowFn = now ?? (() => Date.now());
}

function cooldownSkip(provider: ProviderId): QuotaRefreshOutcome | null {
  const meta = metaByProvider.get(provider);
  if (!meta) return null;
  const now = nowFn();
  if (
    meta.lastSuccessAtEpochMs !== null &&
    now - meta.lastSuccessAtEpochMs < QUOTA_REFRESH_COOLDOWN_MS
  ) {
    return { ok: true, skipped: "cooldown" };
  }
  if (
    meta.lastErrorAtEpochMs !== null &&
    now - meta.lastErrorAtEpochMs < QUOTA_FAILURE_RETRY_COOLDOWN_MS
  ) {
    return { ok: true, skipped: "cooldown" };
  }
  return null;
}

async function runRefresh(
  provider: ProviderId,
  refresher: QuotaRefresher,
  opts: { modelId?: string | undefined },
): Promise<QuotaRefreshOutcome> {
  try {
    const data = await refresher.fetch();
    // Stamp success only after the fetch resolves so a failure does not suppress retries.
    const meta = ensureMeta(provider);
    meta.lastSuccessAtEpochMs = nowFn();
    refresher.apply(data, { modelId: opts.modelId });
    return { ok: true };
  } catch (err) {
    const message = errorMessage(err);
    const meta = ensureMeta(provider);
    meta.lastErrorAtEpochMs = nowFn();
    meta.lastError = message;
    // Do not apply/clear — last-known-good routing quota must survive transient failures.
    return { ok: false, error: message };
  }
}

function ensureMeta(provider: ProviderId): ProviderRefreshMeta {
  const existing = metaByProvider.get(provider);
  if (existing) return existing;
  const created: ProviderRefreshMeta = {
    lastSuccessAtEpochMs: null,
    lastErrorAtEpochMs: null,
    lastError: null,
  };
  metaByProvider.set(provider, created);
  return created;
}

function resolveRefresher(provider: ProviderId): QuotaRefresher | undefined {
  const override = testRefreshers.get(provider);
  if (override) return override;
  return builtinRefresher(provider);
}

// Built as call-time wrappers so circular imports from kimi/antigravity refresh
// wrappers resolve after every module has finished evaluating.
function builtinRefresher(provider: ProviderId): QuotaRefresher | undefined {
  switch (provider) {
    case "anthropic":
      return {
        fetch: () => fetchAnthropicUsage(),
        apply: (data) => applyAnthropicUsageLimits(data as AnthropicUsage | null),
      };
    case "codex":
      return {
        fetch: () => fetchCodexUsage(),
        apply: (data) => applyCodexQuotaWarning(data as CodexUsage | null),
      };
    case "glm":
      return {
        fetch: () => fetchGlmUsage(),
        apply: (data) => applyGlmQuotaWarning(data as PlanQuotaData | null),
      };
    case "minimax":
      return {
        fetch: () => fetchMinimaxUsage(),
        apply: (data) => applyMinimaxQuotaWarning(data as PlanQuotaData | null),
      };
    case "xai":
      return {
        fetch: () => fetchXaiUsage(),
        apply: (data) => applyXaiQuotaWarning(data as PlanQuotaData | null),
      };
    case "kimi-code":
      return {
        fetch: () => fetchKimiUsage(),
        apply: (data) => applyKimiQuotaWarning(data as KimiUsage | null),
      };
    case "antigravity":
      return {
        // Applying Antigravity quota no longer depends on the initiating
        // model: one fetch groups all buckets and atomically replaces both
        // family scopes (claude-gpt, gemini) when represented.
        fetch: () => fetchAntigravityUsage(),
        apply: (data) => applyAntigravityQuotaWarning(data as AntigravityUsage | null),
      };
    default:
      return undefined;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return String(err);
}
