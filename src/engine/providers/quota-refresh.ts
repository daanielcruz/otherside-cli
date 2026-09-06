import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
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
import { fetchDeepseekBalance } from "@/engine/providers/deepseek/usage.ts";
import { applyGlmQuotaWarning, fetchGlmUsage } from "@/engine/providers/glm/usage.ts";
import {
  applyKimiQuotaWarning,
  fetchKimiUsage,
  type KimiUsage,
} from "@/engine/providers/kimi/usage.ts";
import { applyMinimaxQuotaWarning, fetchMinimaxUsage } from "@/engine/providers/minimax/usage.ts";
import {
  deleteSharedQuotaRecord,
  readSharedQuotaRecord,
  writeSharedQuotaError,
  writeSharedQuotaRecord,
} from "@/engine/providers/quota-cache.ts";
import { applyXaiQuotaWarning, fetchXaiUsage } from "@/engine/providers/xai/usage.ts";
import { clearProviderQuotaObservations } from "@/engine/session/usage/limits.ts";
import type { PlanQuotaData } from "@/engine/session/usage/plan-quota.ts";
import { QUOTA_REFRESH_COOLDOWN_MS } from "@/engine/session/usage/quota-warning.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { subscribeCredentialChanges } from "@/kernel/storage/credentials.ts";

/** Failure cooldown is shorter than the success cooldown so a blip can recover sooner. */
export const QUOTA_FAILURE_RETRY_COOLDOWN_MS = 60_000;

/**
 * Tightest success window a user-initiated refresh (e.g. `r` in /usage) may
 * request: within it the last observation is served from cache instead of
 * hitting the provider's usage API, so refresh spam can never trip a rate
 * limit.
 */
export const QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS = 30_000;

export interface QuotaRefreshMeta {
  inFlight: boolean;
  lastSuccessAtEpochMs: number | null;
  lastErrorAtEpochMs: number | null;
  lastError: string | null;
}

export type QuotaRefreshOutcome =
  | { ok: true; source: "network" | "cache"; data: unknown }
  | { ok: true; source: "unsupported"; data: null }
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

interface InFlightQuotaRefresh {
  generation: number;
  promise: Promise<QuotaRefreshOutcome>;
}

const metaByProvider = new Map<ProviderId, ProviderRefreshMeta>();
const inFlightByProvider = new Map<ProviderId, InFlightQuotaRefresh>();
// Last successfully fetched payload per provider; served on cooldown skips so
// every usage surface (panel tabs, companion snapshot) reads through the one
// cooldown gate instead of fetching on its own.
const lastPayloadByProvider = new Map<ProviderId, unknown>();
const credentialGenerationByProvider = new Map<ProviderId, number>();
const accountByProvider = new Map<ProviderId, string>();
const testRefreshers = new Map<ProviderId, QuotaRefresher>();

let nowFn: () => number = () => Date.now();

// A credential write only invalidates usage when the ACCOUNT changed. Fetching usage
// can itself renew a near-expiry access token and save it, and treating that save as a
// change would throw away the very result the fetch produced — and the last-known-good
// display with it. The account fingerprint is stable across token renewal by contract.
subscribeCredentialChanges((provider) => {
  const account = accountFingerprint(provider);
  if (accountByProvider.get(provider) === account) return;
  accountByProvider.set(provider, account);
  invalidateProviderQuota(provider);
});

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
 * Single-flight, cooldown-aware quota refresh — the ONLY path allowed to hit a
 * provider's usage API. A thrown fetch (including the shared 10s AbortSignal
 * timeout) preserves last-known-good quota state: no apply/clear runs on
 * failure. `maxAgeMs` narrows (or widens) this call's success window: a last
 * success younger than it skips the network and serves the cached payload;
 * user-initiated refreshes must not pass anything tighter than
 * QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS.
 */
export async function refreshProviderQuota(
  provider: ProviderId,
  opts: { force?: boolean; maxAgeMs?: number; modelId?: string } = {},
): Promise<QuotaRefreshOutcome> {
  const refresher = resolveRefresher(provider);
  if (!refresher) return { ok: true, source: "unsupported", data: null };

  // Baseline the account before fetching: the fetch itself may renew and save the
  // token, and the change event that save fires must compare against who we were
  // fetching for — not against an empty slot that reads as a switch.
  if (!accountByProvider.has(provider)) {
    accountByProvider.set(provider, accountFingerprint(provider));
  }
  const generation = credentialGeneration(provider);
  const existing = inFlightByProvider.get(provider);
  if (existing?.generation === generation) return existing.promise;

  if (!opts.force) {
    const skip = cooldownSkip(provider, opts.maxAgeMs ?? QUOTA_REFRESH_COOLDOWN_MS);
    if (skip) return skip;
  }

  const promise = runRefresh(provider, refresher, generation, opts).finally(() => {
    const current = inFlightByProvider.get(provider);
    if (current?.promise === promise) inFlightByProvider.delete(provider);
  });
  inFlightByProvider.set(provider, { generation, promise });
  return promise;
}

/**
 * Refresh-through-cache read of a provider's usage payload for display
 * surfaces (/usage tabs, companion snapshot): runs the shared cooldown-gated
 * refresh and returns the — possibly cached — payload, throwing on a failed
 * fetch so callers can render an error state. A cooldown skip that predates
 * any cached payload rethrows the last fetch error.
 */
export async function providerUsagePayload<T>(
  provider: ProviderId,
  opts: { maxAgeMs?: number } = {},
): Promise<T | null> {
  const outcome = await refreshProviderQuota(provider, opts);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.data as T | null;
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
  lastPayloadByProvider.clear();
  credentialGenerationByProvider.clear();
  accountByProvider.clear();
  nowFn = () => Date.now();
}

/** Test-only clock seam for cooldown assertions without real sleeps. */
export function setQuotaRefreshNowForTests(now: (() => number) | null): void {
  nowFn = now ?? (() => Date.now());
}

function cooldownSkip(provider: ProviderId, successWindowMs: number): QuotaRefreshOutcome | null {
  const meta = metaByProvider.get(provider);
  const now = nowFn();
  if (meta?.lastSuccessAtEpochMs != null && now - meta.lastSuccessAtEpochMs < successWindowMs) {
    return cachedOutcome(provider);
  }
  if (
    meta?.lastErrorAtEpochMs != null &&
    now - meta.lastErrorAtEpochMs < QUOTA_FAILURE_RETRY_COOLDOWN_MS
  ) {
    return lastPayloadByProvider.has(provider)
      ? cachedOutcome(provider)
      : { ok: false, error: meta.lastError ?? "usage temporarily unavailable" };
  }

  // No in-process observation fresh enough: adopt a sibling session's shared
  // record so concurrent CLI sessions don't each poll the usage API.
  const shared = readSharedQuotaRecord(provider);
  if (!shared) return null;
  if (shared.lastSuccessAtEpochMs != null && now - shared.lastSuccessAtEpochMs < successWindowMs) {
    const ensured = ensureMeta(provider);
    ensured.lastSuccessAtEpochMs = shared.lastSuccessAtEpochMs;
    ensured.lastErrorAtEpochMs = shared.lastErrorAtEpochMs;
    ensured.lastError = shared.lastError;
    lastPayloadByProvider.set(provider, shared.data);
    return cachedOutcome(provider);
  }
  if (
    shared.lastErrorAtEpochMs != null &&
    now - shared.lastErrorAtEpochMs < QUOTA_FAILURE_RETRY_COOLDOWN_MS
  ) {
    const ensured = ensureMeta(provider);
    ensured.lastSuccessAtEpochMs = shared.lastSuccessAtEpochMs;
    ensured.lastErrorAtEpochMs = shared.lastErrorAtEpochMs;
    ensured.lastError = shared.lastError;
    if (shared.data !== null) {
      lastPayloadByProvider.set(provider, shared.data);
      return cachedOutcome(provider);
    }
    return { ok: false, error: shared.lastError ?? "usage temporarily unavailable" };
  }
  return null;
}

function cachedOutcome(provider: ProviderId): QuotaRefreshOutcome {
  return { ok: true, source: "cache", data: lastPayloadByProvider.get(provider) ?? null };
}

async function runRefresh(
  provider: ProviderId,
  refresher: QuotaRefresher,
  generation: number,
  opts: { modelId?: string | undefined },
): Promise<QuotaRefreshOutcome> {
  try {
    const data = await refresher.fetch();
    if (credentialGeneration(provider) !== generation) {
      return { ok: false, error: "credentials changed during usage refresh" };
    }
    const meta = ensureMeta(provider);
    meta.lastSuccessAtEpochMs = nowFn();
    meta.lastErrorAtEpochMs = null;
    meta.lastError = null;
    lastPayloadByProvider.set(provider, data);
    writeSharedQuotaRecord(provider, {
      version: 1,
      lastSuccessAtEpochMs: meta.lastSuccessAtEpochMs,
      lastErrorAtEpochMs: null,
      lastError: null,
      data,
    });
    refresher.apply(data, { modelId: opts.modelId });
    return { ok: true, source: "network", data };
  } catch (err) {
    if (credentialGeneration(provider) !== generation) {
      return { ok: false, error: "credentials changed during usage refresh" };
    }
    const message = errorMessage(err);
    const meta = ensureMeta(provider);
    meta.lastErrorAtEpochMs = nowFn();
    meta.lastError = message;
    writeSharedQuotaError(provider, meta.lastErrorAtEpochMs, message);
    // Do not apply/clear — last-known-good display data survives transient failures.
    return { ok: false, error: message };
  }
}

function credentialGeneration(provider: ProviderId): number {
  return credentialGenerationByProvider.get(provider) ?? 0;
}

export function invalidateProviderQuota(provider: ProviderId): void {
  credentialGenerationByProvider.set(provider, credentialGeneration(provider) + 1);
  metaByProvider.delete(provider);
  lastPayloadByProvider.delete(provider);
  deleteSharedQuotaRecord(provider);
  clearProviderQuotaObservations(provider);
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
    case "deepseek":
      return {
        fetch: () => fetchDeepseekBalance(),
        apply: (_data) => {},
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
    case "kimi":
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
