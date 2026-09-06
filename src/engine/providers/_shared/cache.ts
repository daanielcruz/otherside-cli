import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

interface CacheStats {
  totalCacheCreation: number;
  totalCacheRead: number;
  turnsWithCache: number;
  turnsWithoutCache: number;
  lastTurnCreation: number;
  lastTurnRead: number;
}

const stats: Map<ProviderId, CacheStats> = new Map();

function get(provider: ProviderId): CacheStats {
  let entry = stats.get(provider);
  if (!entry) {
    entry = {
      totalCacheCreation: 0,
      totalCacheRead: 0,
      turnsWithCache: 0,
      turnsWithoutCache: 0,
      lastTurnCreation: 0,
      lastTurnRead: 0,
    };
    stats.set(provider, entry);
  }
  return entry;
}

export function recordTurnCacheUsage(
  provider: ProviderId,
  cacheCreation: number,
  cacheRead: number,
): void {
  const entry = get(provider);
  entry.totalCacheCreation += Math.max(0, cacheCreation);
  entry.totalCacheRead += Math.max(0, cacheRead);
  entry.lastTurnCreation = cacheCreation;
  entry.lastTurnRead = cacheRead;
  if (cacheCreation > 0 || cacheRead > 0) {
    entry.turnsWithCache += 1;
  } else {
    entry.turnsWithoutCache += 1;
  }
}

export function getCacheHitRatio(provider: ProviderId): number {
  const entry = stats.get(provider);
  if (!entry) return 0;
  const total = entry.totalCacheCreation + entry.totalCacheRead;
  if (total === 0) return 0;
  return entry.totalCacheRead / total;
}

export function getCacheStats(provider: ProviderId): Readonly<CacheStats> | null {
  const entry = stats.get(provider);
  return entry ? { ...entry } : null;
}

export function resetCacheStats(): void {
  stats.clear();
}

export function summarizeCacheUsageAllProviders(): Record<string, Readonly<CacheStats>> {
  const out: Record<string, Readonly<CacheStats>> = {};
  for (const [id, entry] of stats.entries()) {
    out[id] = { ...entry };
  }
  return out;
}
