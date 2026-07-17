import { CATALOG, findFamilyMatch, type ModelEntry, parseModelId } from "@/engine/model/catalog.ts";
import { providerUsabilityNow } from "@/engine/model/tier/resolver.ts";
import { formatResetTime } from "@/engine/session/usage/limits.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import { isProviderId, type ProviderId } from "@/kernel/config/provider-ids.ts";

export interface ModelPinResolution {
  provider: ProviderId;
  model: string;
}

export type ModelPinResult =
  | { ok: true; resolution: ModelPinResolution }
  | { ok: false; error: string };

export function exhaustedProviderLaunchError(
  provider: ProviderId,
  activeProvider: ProviderId | undefined,
  model: string,
  orchestrationMode: OrchestrationMode = "disabled",
): string | null {
  const usability = providerUsabilityNow(provider, activeProvider, model);
  if (!usability.quotaBlocked) return null;
  const routeHint =
    orchestrationMode === "disabled"
      ? " Choose another model from the current provider or retry after the reset."
      : orchestrationMode === "default"
        ? " Pin another provider/model or retry after the reset."
        : " Use `tier` routing or retry after the reset.";
  return `QuotaExhaustedError: provider "${provider}" has exhausted its quota/balance and cannot take this launch${quotaResetSuffix(usability.quotaResetsAtEpochMs)}.${routeHint} Details: ${usability.blockedReasons.join("; ")}.`;
}

function catalogMatch(pin: string, provider: ProviderId): ModelEntry | undefined {
  const catalog = CATALOG().filter((m) => m.provider === provider);
  const exact = catalog.find((m) => m.id === pin);
  if (exact) return exact;
  const base = parseModelId(pin).base;
  const baseMatch = catalog.find((m) => m.id === base);
  if (baseMatch) return baseMatch;
  // Forgiving suffix match so a family shorthand resolves to its catalog id
  // (e.g. "fable-5" → "claude-fable-5") — only when it names exactly one model.
  const suffixMatches = catalog.filter((m) => m.id.endsWith(`-${base}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  // Bare family name with no version (e.g. "sonnet") — same one-match rule,
  // shared with the catalog's own findModel().
  return findFamilyMatch(catalog, base);
}

function providersCarrying(pin: string): ProviderId[] {
  const base = parseModelId(pin).base;
  const catalog = CATALOG();
  const carriers = catalog.filter((m) => m.id === pin || m.id === base).map((m) => m.provider);
  return [...new Set(carriers)];
}

function providerModelIds(provider: ProviderId): string[] {
  return CATALOG()
    .filter((m) => m.provider === provider)
    .map((m) => m.id);
}

/**
 * Resolve an explicit cross-provider (provider, model) pin. A bare model string
 * stays a same-provider concern (the dispatcher's own override path); this
 * resolver exists for callers that name the provider explicitly, so identical
 * model ids carried by more than one provider never route silently.
 *
 * Eligibility comes straight from the live quota SoT — pinning the caller's
 * own session provider grants no exemption: an exhausted provider refuses the
 * launch before it starts, with the exhaustion (and reset time when known)
 * named in the error returned to the calling model.
 */
export function resolveModelPin(
  rawProvider: string,
  pin: string,
  activeProvider?: ProviderId,
  orchestrationMode: OrchestrationMode = "feudalism",
): ModelPinResult {
  if (!isProviderId(rawProvider)) {
    return {
      ok: false,
      error: `InputValidationError: unknown provider "${rawProvider}".`,
    };
  }
  const provider = rawProvider;
  const entry = catalogMatch(pin, provider);
  if (!entry) {
    const carriers = providersCarrying(pin);
    const hint =
      carriers.length > 0
        ? ` It exists on provider(s): ${carriers.join(", ")}.`
        : ` Models on "${provider}": ${providerModelIds(provider).join(", ")}.`;
    return {
      ok: false,
      error: `InputValidationError: model "${pin}" is not available on provider "${provider}".${hint}`,
    };
  }
  const usability = providerUsabilityNow(provider, activeProvider, entry.id);
  if (!usability.usable) {
    if (!usability.credentialsConfigured) {
      return {
        ok: false,
        error: `InputValidationError: provider "${provider}" has no configured credentials. Run \`otherside login --provider ${provider}\` or set its API-key env var.`,
      };
    }
    const quotaError = exhaustedProviderLaunchError(
      provider,
      activeProvider,
      entry.id,
      orchestrationMode,
    );
    if (quotaError !== null) {
      return { ok: false, error: quotaError };
    }
    return {
      ok: false,
      error: `InputValidationError: provider "${provider}" has credentials but is temporarily unavailable: ${usability.blockedReasons.join("; ")}.`,
    };
  }
  return { ok: true, resolution: { provider, model: entry.id } };
}

function quotaResetSuffix(resetsAtEpochMs: number | null): string {
  if (resetsAtEpochMs === null) return "";
  const text = formatResetTime(Math.floor(resetsAtEpochMs / 1000));
  return text === null ? "" : ` (resets ${text})`;
}
