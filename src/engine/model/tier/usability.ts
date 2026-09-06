import { readFileSync, statSync } from "node:fs";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import {
  type CredentialsBundle,
  credentialsPath,
  hasConfiguredCredential,
} from "@/kernel/storage/credentials.ts";

/**
 * Live provider usability: an mtime-memoized credentials read joined with the
 * quota SoT's routeability verdict.
 */

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

export function loadCredentialsSync(): CredentialsBundle | null {
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
