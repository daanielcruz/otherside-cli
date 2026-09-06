import { normalizeEpochMs } from "@/engine/session/usage/routing-usage-normalize.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type ProviderCooldownReason = "rate_limited" | "manual";

export interface ProviderCooldownRecord {
  provider: ProviderId;
  model: string | null;
  reason: ProviderCooldownReason;
  resetEpochMs: number | null;
  untilEpochMs: number;
  observedAtEpochMs: number;
}

export const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;

const PROVIDER_WIDE = "*";
const cooldowns = new Map<string, ProviderCooldownRecord>();

function cooldownKey(provider: ProviderId, model?: string | null): string {
  return `${provider}\0${model ?? PROVIDER_WIDE}`;
}

function recordIfActive(key: string): ProviderCooldownRecord | null {
  const record = cooldowns.get(key);
  if (record === undefined) return null;
  if (Date.now() >= record.untilEpochMs) {
    cooldowns.delete(key);
    return null;
  }
  return { ...record };
}

export function markProviderCooldown(
  provider: ProviderId,
  resetEpochMs: number | null,
  reason: ProviderCooldownReason = "rate_limited",
  model?: string | null,
): void {
  const observedAtEpochMs = Date.now();
  const normalizedResetEpochMs = normalizeEpochMs(resetEpochMs);
  const untilEpochMs = normalizedResetEpochMs ?? observedAtEpochMs + DEFAULT_PROVIDER_COOLDOWN_MS;
  const scopedModel = model && model.length > 0 ? model : null;
  cooldowns.set(cooldownKey(provider, scopedModel), {
    provider,
    model: scopedModel,
    reason,
    resetEpochMs: normalizedResetEpochMs ?? null,
    untilEpochMs,
    observedAtEpochMs,
  });
}

export function getProviderCooldown(
  provider: ProviderId,
  model?: string | null,
): ProviderCooldownRecord | null {
  const providerWide = recordIfActive(cooldownKey(provider));
  if (providerWide !== null) return providerWide;
  if (model === undefined || model === null || model.length === 0) return null;
  return recordIfActive(cooldownKey(provider, model));
}

export function getProviderCooldowns(): Partial<Record<ProviderId, ProviderCooldownRecord>> {
  const out: Partial<Record<ProviderId, ProviderCooldownRecord>> = {};
  for (const record of listProviderCooldowns()) {
    if (record.model === null) out[record.provider] = record;
  }
  return out;
}

export function listProviderCooldowns(): ProviderCooldownRecord[] {
  const out: ProviderCooldownRecord[] = [];
  for (const key of cooldowns.keys()) {
    const active = recordIfActive(key);
    if (active !== null) out.push(active);
  }
  return out.sort((a, b) => {
    const providerOrder = a.provider.localeCompare(b.provider);
    if (providerOrder !== 0) return providerOrder;
    return (a.model ?? "").localeCompare(b.model ?? "");
  });
}

export function isProviderHealthy(provider: ProviderId, model?: string | null): boolean {
  return getProviderCooldown(provider, model) === null;
}

export function clearProviderCooldown(provider: ProviderId): void {
  for (const record of listProviderCooldowns()) {
    if (record.provider === provider) cooldowns.delete(cooldownKey(record.provider, record.model));
  }
}

export function clearProviderCooldowns(): void {
  cooldowns.clear();
}
