import { readFileSync, statSync } from "node:fs";
import type { TierName } from "@/engine/model/tier/names.ts";
import {
  baseModelId,
  GENERAL_MODELS,
  SCOUT_MODELS,
  type TierModel,
  WARRIOR_MODELS,
} from "@/engine/model/tier/tiers.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { RoutingBalanceStatus, RoutingTrackingStatus } from "@/engine/session/usage/limits.ts";
import {
  type ProviderRoutingUsageSource,
  providerRouteability,
} from "@/engine/session/usage/provider-routeability.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import {
  type CredentialsBundle,
  credentialsPath,
  hasConfiguredCredential,
} from "@/kernel/storage/credentials.ts";

const TIER_LISTS: Record<TierName, readonly TierModel[]> = {
  general: GENERAL_MODELS,
  warrior: WARRIOR_MODELS,
  scout: SCOUT_MODELS,
};

export interface TierResolution {
  provider: ProviderId;
  model: string;
}

export interface TierCandidateDetail {
  tier: TierName;
  rank: number;
  provider: ProviderId;
  model: string;
  resolution: TierResolution;
  usable: boolean;
  blocked: boolean;
  // True when quota observations (utilization threshold, exhausted balance, or
  // a spent model-scoped window) are among the block causes.
  quotaBlocked: boolean;
  unobservedProvider: boolean;
  summary: string;
  notes: string[];
  blockedReasons: string[];
  credentialsConfigured: boolean;
  modelAvailable: boolean;
  cooldownUntilEpochMs: number | null;
  routing: {
    trackingStatus: RoutingTrackingStatus;
    utilizationPct: number | null;
    balanceStatus: RoutingBalanceStatus;
    observedAtEpochMs: number;
    resetsAtEpochMs: number | null;
    source: ProviderRoutingUsageSource;
  };
}

export interface TierResolutionDetail {
  tier: TierName;
  candidates: TierCandidateDetail[];
  selected: TierCandidateDetail | null;
  resolution: TierResolution | null;
  error: string | null;
}

export interface TierTopNResolutionDetail {
  tier: TierName;
  requestedCount: number;
  candidates: TierCandidateDetail[];
  selected: TierCandidateDetail[];
  resolutions: TierResolution[];
  error: string | null;
}

export interface TierRankResolutionDetail {
  tier: TierName;
  rank: number;
  candidate: TierCandidateDetail | null;
  resolution: TierResolution | null;
  error: string | null;
}

export interface TierCascadeResolutionDetail {
  requestedTier: TierName;
  tiers: TierResolutionDetail[];
  selectedTier: TierName | null;
  selected: TierCandidateDetail | null;
  resolution: TierResolution | null;
  error: string | null;
}

export interface TierTopNCascadeResolutionDetail {
  requestedTier: TierName;
  requestedCount: number;
  tiers: TierTopNResolutionDetail[];
  selectedTier: TierName | null;
  selected: TierCandidateDetail[];
  resolutions: TierResolution[];
  error: string | null;
}

let credentialsLoaderOverride: (() => CredentialsBundle | null) | null = null;

interface CredentialsMemo {
  path: string | null;
  bundle: CredentialsBundle | null;
  mtimeMs: number | null;
}

let credentialsMemo: CredentialsMemo = { path: null, bundle: null, mtimeMs: null };

/**
 * Test-only hook so resolver unit tests can run hermetically without reading the
 * real ~/.otherside/credentials.json. Pass null to restore disk loading.
 */
export function setCredentialsLoaderForTests(
  loader: (() => CredentialsBundle | null) | null,
): void {
  credentialsLoaderOverride = loader;
}

/** Test-only: drop the file-based credentials memo so the next load re-reads disk. */
export function invalidateCredentialsMemoForTests(): void {
  credentialsMemo = { path: null, bundle: null, mtimeMs: null };
}

function loadCredentialsSync(): CredentialsBundle | null {
  if (credentialsLoaderOverride !== null) return credentialsLoaderOverride();
  const path = credentialsPath();
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Missing file (or unreadable path) — memoize the absence.
    credentialsMemo = { path, bundle: null, mtimeMs: null };
    return null;
  }
  if (credentialsMemo.path === path && credentialsMemo.mtimeMs === mtimeMs) {
    return credentialsMemo.bundle;
  }
  try {
    const bundle = JSON.parse(readFileSync(path, "utf8")) as CredentialsBundle;
    credentialsMemo = { path, bundle, mtimeMs };
    return bundle;
  } catch {
    credentialsMemo = { path, bundle: null, mtimeMs };
    return null;
  }
}

/**
 * Live usability: configured credentials + routeable per the quota SoT. There
 * is no active-provider exemption — an exhausted provider is unusable for
 * delegated work even when it is the main session's own provider
 * (`activeProvider` is retained for call compatibility only).
 */
export function isProviderUsable(
  provider: ProviderId,
  creds: CredentialsBundle | null,
  activeProvider?: ProviderId,
  model?: string | null,
): boolean {
  if (!hasConfiguredCredential(creds, provider)) return false;
  return providerRouteability(provider, activeProvider, model).usable;
}

/**
 * Live usability check that loads credentials internally — for callers (the
 * workflow bridge) that hold no CredentialsBundle. Every allocation re-checks
 * against the live quota SoT; a provider that recovered is usable immediately.
 */
export function isProviderUsableNow(
  provider: ProviderId,
  activeProvider?: ProviderId,
  model?: string | null,
): boolean {
  return isProviderUsable(provider, loadCredentialsSync(), activeProvider, model);
}

export interface ProviderUsabilityDetail {
  usable: boolean;
  credentialsConfigured: boolean;
  blockedReasons: string[];
  // True when quota observations (exhausted balance / 100% utilization) are
  // among the block causes — structured so launch refusals can name quota
  // exhaustion truthfully instead of parsing reason strings.
  quotaBlocked: boolean;
  /** Reset epoch of the blocking quota window when the SoT knows it. */
  quotaResetsAtEpochMs: number | null;
}

/**
 * Like isProviderUsableNow, but keeps "no credentials at all" and "credentials
 * present but blocked (cooldown / quota exhaustion)" distinguishable so callers
 * can report the real cause instead of a generic credentials error.
 */
export function providerUsabilityNow(
  provider: ProviderId,
  activeProvider?: ProviderId,
  model?: string | null,
): ProviderUsabilityDetail {
  const credentialsConfigured = hasConfiguredCredential(loadCredentialsSync(), provider);
  if (!credentialsConfigured) {
    return {
      usable: false,
      credentialsConfigured,
      blockedReasons: ["no configured credentials"],
      quotaBlocked: false,
      quotaResetsAtEpochMs: null,
    };
  }
  const routeability = providerRouteability(provider, activeProvider, model);
  return {
    usable: routeability.usable,
    credentialsConfigured,
    blockedReasons: routeability.blockedReasons,
    quotaBlocked: routeability.quotaBlocked,
    quotaResetsAtEpochMs: routeability.quotaBlocked
      ? (routeability.routing.state.resetsAtEpochMs ?? null)
      : null,
  };
}

export function resolveTier(
  tier: TierName,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierResolution | null {
  return resolveTierDetailed(tier, exclude, activeProvider).resolution;
}

/**
 * Is (provider, model) one of the models that defines this tier? Compared on the
 * base model id so a context-window variant (e.g. `claude-opus-4-8[1m]`) matches its
 * roster entry. Used to keep an agent on the caller's own model when the caller
 * already belongs to the tier it is routing to, instead of escalating to top-1.
 */
export function tierContainsModel(tier: TierName, provider: ProviderId, model: string): boolean {
  return tierModelEntry(tier, provider, model) !== null;
}

export function isTierModelUsableNow(
  tier: TierName,
  provider: ProviderId,
  model: string,
  activeProvider?: ProviderId,
): boolean {
  return tierModelCandidateNow(tier, provider, model, activeProvider)?.usable ?? false;
}

/** Full candidate evaluation for one (tier, provider, model) roster entry, or null when not in the roster. */
export function tierModelCandidateNow(
  tier: TierName,
  provider: ProviderId,
  model: string,
  activeProvider?: ProviderId,
): TierCandidateDetail | null {
  const entry = tierModelEntry(tier, provider, model);
  if (entry === null) return null;
  const rank = stableTierRoster(tier).indexOf(entry) + 1;
  if (rank < 1) return null;
  return evaluateTierCandidate(entry, rank, loadCredentialsSync(), undefined, activeProvider);
}

/**
 * True when a candidate lost its routing slot to quota alone: quota-blocked yet
 * otherwise viable. Cooldown-carrying candidates are excluded — transient
 * cooldowns belong to the interactive deviation machinery, and once the
 * cooldown lapses this predicate reassesses against the live quota SoT.
 */
export function isQuotaDisplacedCandidate(candidate: TierCandidateDetail): boolean {
  return (
    candidate.quotaBlocked &&
    candidate.credentialsConfigured &&
    candidate.modelAvailable &&
    candidate.cooldownUntilEpochMs === null
  );
}

/**
 * The main-session provider, but only while it is live-usable: exhausted quota
 * or a runtime cooldown drops it like any other provider (the former
 * usage/balance exemption is gone — eligibility comes straight from the quota
 * SoT). Callers use the result to prefer keeping the caller's own route.
 */
export function usableActiveProviderForTierResolution(
  provider: ProviderId,
): ProviderId | undefined {
  return isProviderUsable(provider, loadCredentialsSync(), provider) ? provider : undefined;
}

function tierModelEntry(tier: TierName, provider: ProviderId, model: string): TierModel | null {
  const list = TIER_LISTS[tier];
  if (!list) return null;
  const base = baseModelId(model);
  return (
    list.find((entry) => entry.provider === provider && baseModelId(entry.name) === base) ?? null
  );
}

export function resolveTierTopN(
  tier: TierName,
  count: number,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierResolution[] {
  return resolveTierTopNDetailed(tier, count, exclude, activeProvider).resolutions;
}

export function resolveTierWithCascade(
  tier: TierName,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierResolution | null {
  return resolveTierWithCascadeDetailed(tier, exclude, activeProvider).resolution;
}

export function resolvedTierSummary(
  activeProvider?: ProviderId,
): Record<TierName, TierResolution | null> {
  return {
    general: resolveTier("general", undefined, activeProvider),
    warrior: resolveTier("warrior", undefined, activeProvider),
    scout: resolveTier("scout", undefined, activeProvider),
  };
}

export function resolvedTierRoster(
  activeProvider?: ProviderId,
): Record<TierName, TierResolution[]> {
  return {
    general: resolveTierTopN("general", 3, undefined, activeProvider),
    warrior: resolveTierTopN("warrior", 3, undefined, activeProvider),
    scout: resolveTierTopN("scout", 3, undefined, activeProvider),
  };
}

export function resolveTierRank(
  tier: TierName,
  rank: number,
  activeProvider?: ProviderId,
): TierResolution | null {
  return resolveTierRankDetailed(tier, rank, activeProvider).resolution;
}

export function resolveTierDetailed(
  tier: TierName,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierResolutionDetail {
  const creds = loadCredentialsSync();
  const candidates = evaluateTierCandidates(tier, creds, exclude, activeProvider);
  const selected =
    candidates.find((candidate) => candidate.usable && !candidate.unobservedProvider) ??
    candidates.find((candidate) => candidate.usable) ??
    null;
  return {
    tier,
    candidates,
    selected,
    resolution: selected?.resolution ?? null,
    error: selected ? null : noUsableTierError(tier, candidates),
  };
}

export function resolveTierTopNDetailed(
  tier: TierName,
  count: number,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierTopNResolutionDetail {
  const creds = loadCredentialsSync();
  const candidates = evaluateTierCandidates(tier, creds, exclude, activeProvider);
  const selected: TierCandidateDetail[] = [];
  const selectedProviders = new Set<ProviderId>();
  if (count > 0) {
    // First pass: observed + usable
    for (const candidate of candidates) {
      if (!candidate.usable || candidate.unobservedProvider) continue;
      if (selectedProviders.has(candidate.provider)) continue;
      selectedProviders.add(candidate.provider);
      selected.push(candidate);
      if (selected.length >= count) break;
    }
    // Second pass: unobserved + usable
    if (selected.length < count) {
      for (const candidate of candidates) {
        if (!candidate.usable || !candidate.unobservedProvider) continue;
        if (selectedProviders.has(candidate.provider)) continue;
        selectedProviders.add(candidate.provider);
        selected.push(candidate);
        if (selected.length >= count) break;
      }
    }
  }
  return {
    tier,
    requestedCount: count,
    candidates,
    selected,
    resolutions: selected.map((candidate) => candidate.resolution),
    error: count > 0 && selected.length === 0 ? noUsableTierError(tier, candidates) : null,
  };
}

export function resolveTierRankDetailed(
  tier: TierName,
  rank: number,
  activeProvider?: ProviderId,
): TierRankResolutionDetail {
  if (!Number.isInteger(rank) || rank < 1) {
    return {
      tier,
      rank,
      candidate: null,
      resolution: null,
      error: `tier rank ${rank} is invalid`,
    };
  }
  const roster = stableTierRoster(tier);
  const entry = roster[rank - 1];
  if (!entry) {
    return {
      tier,
      rank,
      candidate: null,
      resolution: null,
      error: `tier "${tier}" does not have a stable roster entry at rank ${rank}`,
    };
  }
  const creds = loadCredentialsSync();
  const candidate = evaluateTierCandidate(entry, rank, creds, undefined, activeProvider);
  return {
    tier,
    rank,
    candidate,
    resolution: candidate.usable ? candidate.resolution : null,
    error: candidate.usable ? null : candidate.summary,
  };
}

export function resolveTierWithCascadeDetailed(
  tier: TierName,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierCascadeResolutionDetail {
  const cascade: TierName[] =
    tier === "general"
      ? ["general", "warrior", "scout"]
      : tier === "warrior"
        ? ["warrior", "scout"]
        : ["scout"];
  const tiers: TierResolutionDetail[] = [];
  for (const nextTier of cascade) {
    const detail = resolveTierDetailed(nextTier, exclude, activeProvider);
    tiers.push(detail);
    if (detail.selected) {
      return {
        requestedTier: tier,
        tiers,
        selectedTier: nextTier,
        selected: detail.selected,
        resolution: detail.resolution,
        error: null,
      };
    }
  }
  return {
    requestedTier: tier,
    tiers,
    selectedTier: null,
    selected: null,
    resolution: null,
    error: noCascadeUsableTierError(tier, tiers),
  };
}

export function resolveTierTopNWithCascadeDetailed(
  tier: TierName,
  count: number,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierTopNCascadeResolutionDetail {
  const cascade: TierName[] =
    tier === "general"
      ? ["general", "warrior", "scout"]
      : tier === "warrior"
        ? ["warrior", "scout"]
        : ["scout"];
  const tiers: TierTopNResolutionDetail[] = [];
  for (const nextTier of cascade) {
    const detail = resolveTierTopNDetailed(nextTier, count, exclude, activeProvider);
    tiers.push(detail);
    if (detail.selected.length > 0) {
      return {
        requestedTier: tier,
        requestedCount: count,
        tiers,
        selectedTier: nextTier,
        selected: detail.selected,
        resolutions: detail.resolutions,
        error: null,
      };
    }
  }
  return {
    requestedTier: tier,
    requestedCount: count,
    tiers,
    selectedTier: null,
    selected: [],
    resolutions: [],
    error: noCascadeTopNUsableTierError(tier, tiers),
  };
}

export function quotaDisplacedBeforeTopNSelection(
  detail: TierTopNCascadeResolutionDetail,
): TierCandidateDetail | null {
  for (const tierDetail of detail.tiers) {
    if (detail.selectedTier !== null && tierDetail.tier === detail.selectedTier) {
      break;
    }
    for (const candidate of tierDetail.candidates) {
      if (isQuotaDisplacedCandidate(candidate)) {
        return candidate;
      }
    }
  }

  if (detail.selectedTier !== null) {
    const selectedTierDetail = detail.tiers.find((t) => t.tier === detail.selectedTier);
    if (selectedTierDetail) {
      const candidates = selectedTierDetail.candidates;
      const selected = detail.selected;
      const picked = new Set(selected);

      if (selected.length < detail.requestedCount) {
        for (const candidate of candidates) {
          if (!picked.has(candidate) && isQuotaDisplacedCandidate(candidate)) {
            return candidate;
          }
        }
      } else {
        const last = selected[selected.length - 1];
        const lastIdx = last !== undefined ? candidates.indexOf(last) : -1;
        const end = lastIdx >= 0 ? lastIdx : candidates.length;
        for (let i = 0; i < end; i++) {
          const candidate = candidates[i];
          if (candidate === undefined || picked.has(candidate)) continue;
          if (isQuotaDisplacedCandidate(candidate)) return candidate;
        }
      }
    }
  }

  return null;
}

function noCascadeTopNUsableTierError(tier: TierName, tiers: TierTopNResolutionDetail[]): string {
  const detail = tiers
    .map((candidateTier) =>
      candidateTier.candidates.map((candidate) => candidate.summary).join(" | "),
    )
    .filter((value) => value.length > 0)
    .join(" || ");
  const cascade =
    tier === "general"
      ? "general -> warrior -> scout"
      : tier === "warrior"
        ? "warrior -> scout"
        : "scout";
  return detail.length > 0
    ? `No usable provider found for tier cascade ${cascade}. Diagnostics: ${detail}`
    : `No usable provider found for tier cascade ${cascade}.`;
}

function stableTierRoster(tier: TierName): readonly TierModel[] {
  // Defensive: an invalid or legacy tier name (e.g. "best", "explorer") must not
  // spread `undefined` and throw a TypeError; callers degrade to "no candidates".
  const list = TIER_LISTS[tier];
  if (!list) return [];
  return [...list].sort((a, b) => a.pos - b.pos);
}

function evaluateTierCandidates(
  tier: TierName,
  creds: CredentialsBundle | null,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierCandidateDetail[] {
  return stableTierRoster(tier).map((entry, index) =>
    evaluateTierCandidate(entry, index + 1, creds, exclude, activeProvider),
  );
}

function evaluateTierCandidate(
  entry: TierModel,
  rank: number,
  creds: CredentialsBundle | null,
  exclude?: ProviderId,
  activeProvider?: ProviderId,
): TierCandidateDetail {
  if (entry.provider === exclude) {
    return buildExcludedCandidate(entry, rank, "excluded by caller");
  }

  const routeability = providerRouteability(entry.provider, activeProvider, entry.name);
  const routing = routeability.routing;
  const notes = [...routeability.notes];
  const blockedReasons = [...routeability.blockedReasons];

  const credentialsConfigured = hasConfiguredCredential(creds, entry.provider);
  if (!credentialsConfigured) blockedReasons.push(`missing credential for ${entry.provider}`);

  let modelAvailable = false;
  try {
    const provider = providers.get(entry.provider);
    modelAvailable = provider.modelAvailable(entry.name);
    if (!modelAvailable)
      blockedReasons.push(`model ${entry.name} unavailable on ${entry.provider}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    blockedReasons.push(`provider registry error: ${reason}`);
  }

  // Model/family-scoped quota windows (e.g. Anthropic's Fable weekly bucket,
  // Codex's Spark family) are resolved generically by providerRouteability
  // above, which was already called with this candidate's own model — a
  // spent family-scoped window blocks just this candidate (quotaBlocked +
  // blockedReasons already reflect it) so the cascade falls through to the
  // next tier model instead of skipping the whole provider.
  const quotaBlocked = routeability.quotaBlocked;

  const summaryParts = [...notes, ...blockedReasons];
  const usable = blockedReasons.length === 0;
  return {
    tier: tierForEntry(entry),
    rank,
    provider: entry.provider,
    model: entry.name,
    resolution: { provider: entry.provider, model: entry.name },
    usable,
    blocked: !usable,
    quotaBlocked,
    unobservedProvider: routing.source === "unobserved",
    summary: `${entry.provider}/${entry.name} ${usable ? "routeable" : "blocked"}${
      summaryParts.length > 0 ? `: ${summaryParts.join("; ")}` : ""
    }`,
    notes,
    blockedReasons,
    credentialsConfigured,
    modelAvailable,
    cooldownUntilEpochMs: routeability.cooldown?.untilEpochMs ?? null,
    routing: {
      trackingStatus: routing.state.trackingStatus,
      utilizationPct: routing.state.utilizationPct ?? null,
      balanceStatus: routing.state.balanceStatus,
      observedAtEpochMs: routing.state.observedAtEpochMs,
      resetsAtEpochMs: routing.state.resetsAtEpochMs ?? null,
      source: routing.source,
    },
  };
}

function buildExcludedCandidate(
  entry: TierModel,
  rank: number,
  reason: string,
): TierCandidateDetail {
  const routing = providerRouteability(entry.provider, undefined, entry.name).routing;
  return {
    tier: tierForEntry(entry),
    rank,
    provider: entry.provider,
    model: entry.name,
    resolution: { provider: entry.provider, model: entry.name },
    usable: false,
    blocked: true,
    quotaBlocked: false,
    unobservedProvider: routing.source === "unobserved",
    summary: `${entry.provider}/${entry.name} blocked: ${reason}`,
    notes: [reason],
    blockedReasons: [reason],
    credentialsConfigured: false,
    modelAvailable: false,
    cooldownUntilEpochMs: null,
    routing: {
      trackingStatus: routing.state.trackingStatus,
      utilizationPct: routing.state.utilizationPct ?? null,
      balanceStatus: routing.state.balanceStatus,
      observedAtEpochMs: routing.state.observedAtEpochMs,
      resetsAtEpochMs: routing.state.resetsAtEpochMs ?? null,
      source: routing.source,
    },
  };
}

function tierForEntry(entry: TierModel): TierName {
  if (GENERAL_MODELS.includes(entry)) return "general";
  if (WARRIOR_MODELS.includes(entry)) return "warrior";
  return "scout";
}

function noUsableTierError(tier: TierName, candidates: TierCandidateDetail[]): string {
  const detail = candidates.map((candidate) => candidate.summary).join(" | ");
  return detail.length > 0
    ? `No usable provider found for tier "${tier}". Diagnostics: ${detail}`
    : `No usable provider found for tier "${tier}".`;
}

function noCascadeUsableTierError(tier: TierName, tiers: TierResolutionDetail[]): string {
  const detail = tiers
    .map((candidateTier) =>
      candidateTier.candidates.map((candidate) => candidate.summary).join(" | "),
    )
    .filter((value) => value.length > 0)
    .join(" || ");
  const cascade =
    tier === "general"
      ? "general -> warrior -> scout"
      : tier === "warrior"
        ? "warrior -> scout"
        : "scout";
  return detail.length > 0
    ? `No usable provider found for tier cascade ${cascade}. Diagnostics: ${detail}`
    : `No usable provider found for tier cascade ${cascade}.`;
}
