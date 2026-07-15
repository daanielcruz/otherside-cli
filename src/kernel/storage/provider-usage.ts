import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export interface QuotaBar {
  label: string;
  utilization: number;
  resetsAt: string | null;
  subtext: string | null;
}

export interface ProviderQuota {
  id: string;
  name: string;
  eligible: boolean;
  currentTokens: number;
  allTimeTokens: number;
  bars: QuotaBar[];
  warning: string | null;
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  thinking: number;
  total: number;
}

export interface UsageSnapshot {
  session: UsageTotals;
  allTime: UsageTotals;
  providers: ProviderQuota[];
}

export interface ContextUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  thoughtTokens?: number;
}

export interface ProviderUsageTotals {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  lastModel?: string | undefined;
}

export type UsageByProvider = Partial<Record<ProviderId, ProviderUsageTotals>>;

export interface ProviderUsageProvider {
  latestContextUsageSnapshotFromSessionRecords(
    records: readonly unknown[],
    provider?: string,
    usageRecords?: readonly unknown[],
  ): ContextUsageSnapshot | null;
  usageByProviderFromRecords(records: readonly unknown[]): UsageByProvider;
  fetchUsageSnapshot(currentUsage: UsageByProvider): Promise<UsageSnapshot>;
}

let provider: ProviderUsageProvider | null = null;

export function emptyUsageSnapshot(): UsageSnapshot {
  const emptyTotals = { requests: 0, input: 0, output: 0, thinking: 0, total: 0 };
  return { session: emptyTotals, allTime: emptyTotals, providers: [] };
}

export function registerProviderUsageProvider(impl: ProviderUsageProvider): void {
  provider = impl;
}

function requireProviderUsageProvider(): ProviderUsageProvider {
  if (provider === null) {
    throw new Error("Provider usage provider is not registered");
  }
  return provider;
}

export function latestContextUsageSnapshotFromSessionRecords(
  records: readonly unknown[],
  provider?: string,
  usageRecords?: readonly unknown[],
): ContextUsageSnapshot | null {
  return requireProviderUsageProvider().latestContextUsageSnapshotFromSessionRecords(
    records,
    provider,
    usageRecords,
  );
}

export function usageByProviderFromRecords(records: readonly unknown[]): UsageByProvider {
  return requireProviderUsageProvider().usageByProviderFromRecords(records);
}

export function fetchUsageSnapshot(currentUsage: UsageByProvider): Promise<UsageSnapshot> {
  return requireProviderUsageProvider().fetchUsageSnapshot(currentUsage);
}

export function _resetProviderUsageProviderForTests(): void {
  provider = null;
}
