import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import {
  applyAnthropicUsageLimits,
  fetchAnthropicUsage,
} from "@/engine/providers/anthropic/usage.ts";
import {
  applyAntigravityQuotaWarning,
  fetchAntigravityUsage,
} from "@/engine/providers/antigravity/usage.ts";
import { applyCodexQuotaWarning, fetchCodexUsage } from "@/engine/providers/codex/usage.ts";
import { applyGlmQuotaWarning, fetchGlmUsage } from "@/engine/providers/glm/usage.ts";
import {
  applyKimiQuotaWarning,
  fetchKimiUsage,
  type KimiUsageRow,
} from "@/engine/providers/kimi/usage.ts";
import { applyMinimaxQuotaWarning, fetchMinimaxUsage } from "@/engine/providers/minimax/usage.ts";
import { applyXaiQuotaWarning, fetchXaiUsage } from "@/engine/providers/xai/usage.ts";
import { latestContextUsageSnapshotFromSessionRecords } from "@/engine/session/state.ts";
import { warningForProvider } from "@/engine/session/usage/limits.ts";
import type { PlanQuotaData } from "@/engine/session/usage/plan-quota.ts";
import {
  emptyProviderUsage,
  type ProviderUsageTotals,
  totalProviderTokens,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import {
  allTimeUsageByProviderAsync,
  usageByProviderFromRecords,
} from "@/engine/session/usage/store.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { hasCredential, loadAll, type ProviderSlug } from "@/kernel/storage/credentials.ts";
import {
  type ProviderQuota,
  type QuotaBar,
  registerProviderUsageProvider,
  type UsageSnapshot,
  type UsageTotals,
} from "@/kernel/storage/provider-usage.ts";

// A provider-agnostic quota view: one bar per rate-limit window, mirroring what
// the /usage panel renders per provider tab, flattened for broadcast to the
// companion app. `utilization` is a 0-100 percentage; `resetsAt` an ISO string.

type RateLimit = { utilization: number | null; resetsAt: string | null } | null | undefined;

function barFrom(label: string, limit: RateLimit, subtext: string | null = null): QuotaBar | null {
  if (!limit) return null;
  const { utilization } = limit;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  return { label, utilization, resetsAt: limit.resetsAt ?? null, subtext };
}

// Every collector routes its freshly fetched payload through the provider's
// apply* helper BEFORE building bars, so the SoT (warning + routing
// eligibility) and the returned bars derive from the same observation — a
// snapshot never pairs fresh bars with a stale cached warning.

async function anthropicBars(): Promise<QuotaBar[]> {
  const data = await fetchAnthropicUsage();
  applyAnthropicUsageLimits(data);
  if (!data) return [];
  return [
    barFrom("Current session", data.fiveHour),
    barFrom("Current week (all models)", data.sevenDay),
    barFrom("Current week (Fable)", data.sevenDayFable),
  ].filter((bar): bar is QuotaBar => bar !== null);
}

async function codexBars(): Promise<QuotaBar[]> {
  const data = await fetchCodexUsage();
  applyCodexQuotaWarning(data);
  if (!data) return [];
  const spark = data.additional?.find((limit) =>
    `${limit.id ?? ""} ${limit.label}`.toLowerCase().includes("spark"),
  );
  return [
    barFrom("Current session", data.primary),
    barFrom("Current week (all models)", data.secondary),
    barFrom("Current week (GPT-5.3-Codex-Spark only)", spark?.secondary),
  ].filter((bar): bar is QuotaBar => bar !== null);
}

async function antigravityBars(): Promise<QuotaBar[]> {
  const data = await fetchAntigravityUsage();
  // Applying Antigravity quota no longer depends on a model: both families
  // are grouped and stored atomically from this single fetch.
  applyAntigravityQuotaWarning(data);
  if (!data) return [];
  const bars: QuotaBar[] = [];
  for (const group of data.groups) {
    for (const bucket of group.buckets) {
      const bar = barFrom(bucket.displayName, {
        utilization: bucket.utilization,
        resetsAt: bucket.resetsAt,
      });
      if (bar) bars.push(bar);
    }
  }
  return bars;
}

// Mirrors kimiUsageLimit in the /usage panel: percentage from used/limit, reset
// derived from an absolute timestamp or a countdown, kept here to avoid an
// engine→ui import.
function kimiBar(row: KimiUsageRow): QuotaBar {
  const utilization = row.limit > 0 ? (Math.max(0, row.used) / row.limit) * 100 : 0;
  const resetsAt =
    row.resetsAt ??
    (row.resetInSeconds && row.resetInSeconds > 0
      ? new Date(Date.now() + row.resetInSeconds * 1000).toISOString()
      : null);
  return { label: row.label, utilization, resetsAt, subtext: null };
}

async function kimiBars(): Promise<QuotaBar[]> {
  const data = await fetchKimiUsage();
  applyKimiQuotaWarning(data);
  if (!data) return [];
  return [data.summary, ...data.limits]
    .filter((row): row is KimiUsageRow => row !== undefined)
    .map(kimiBar);
}

function planQuotaBars(data: PlanQuotaData | null): QuotaBar[] {
  if (!data) return [];
  const bars: QuotaBar[] = [];
  for (const window of data.windows) {
    const bar = barFrom(window.label, window.limit, window.detail ?? null);
    if (bar) bars.push(bar);
  }
  return bars;
}

const QUOTA_COLLECTORS: Partial<Record<ProviderId, () => Promise<QuotaBar[]>>> = {
  anthropic: anthropicBars,
  codex: codexBars,
  antigravity: antigravityBars,
  "kimi-code": kimiBars,
  glm: async () => {
    const data = await fetchGlmUsage();
    applyGlmQuotaWarning(data);
    return planQuotaBars(data);
  },
  minimax: async () => {
    const data = await fetchMinimaxUsage();
    applyMinimaxQuotaWarning(data);
    return planQuotaBars(data);
  },
  xai: async () => {
    const data = await fetchXaiUsage();
    applyXaiQuotaWarning(data);
    return planQuotaBars(data);
  },
};

function usageProviderIds(): ProviderId[] {
  return listProviderConfigs()
    .map((config) => config.provider.id)
    .filter((id) => id !== "openai-custom");
}

// Aggregates every provider's counters into one total, matching totalUsage in
// the /usage panel (inlined to avoid an engine→ui import).
function totalUsage(usageByProvider: UsageByProvider): ProviderUsageTotals {
  const total = emptyProviderUsage();
  for (const usage of Object.values(usageByProvider)) {
    if (!usage) continue;
    total.requestCount += usage.requestCount;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.thoughtTokens += usage.thoughtTokens;
    total.cacheCreationInputTokens =
      (total.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
    total.cacheReadInputTokens =
      (total.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  }
  return total;
}

function usageTotals(usage: ProviderUsageTotals): UsageTotals {
  return {
    requests: usage.requestCount,
    input: usage.inputTokens,
    output: usage.outputTokens,
    thinking: usage.thoughtTokens,
    total: totalProviderTokens(usage),
  };
}

async function barsFor(id: ProviderId, eligible: boolean): Promise<QuotaBar[]> {
  const collect = QUOTA_COLLECTORS[id];
  if (!eligible || !collect) return [];
  try {
    return await collect();
  } catch {
    return [];
  }
}

// Builds the full usage snapshot mirroring the /usage panel: the General-tab
// token aggregates (this session + all time) plus, per non-hidden provider, its
// token totals and live quota bars. Live quota is fetched only for credentialed
// providers; a per-provider fetch failure yields empty bars (and the warning
// falls back to the SoT's last-known-good state), never sinks the snapshot.
export async function fetchUsageSnapshot(currentUsage: UsageByProvider): Promise<UsageSnapshot> {
  const credentials = await loadAll();
  const allTime = await allTimeUsageByProviderAsync();
  const providers = await Promise.all(
    usageProviderIds().map(async (id): Promise<ProviderQuota> => {
      const eligible = hasCredential(credentials, id as ProviderSlug);
      // barsFor applies the fetched payload into the usage SoT before the
      // warning is read below, so bars and warning reflect the same observation.
      const bars = await barsFor(id, eligible);
      return {
        id,
        name: getProviderConfig(id)?.provider.label ?? id,
        eligible,
        currentTokens: totalProviderTokens(currentUsage[id] ?? emptyProviderUsage()),
        allTimeTokens: totalProviderTokens(allTime[id] ?? emptyProviderUsage()),
        bars,
        warning: warningForProvider(id)?.message ?? null,
      };
    }),
  );
  return {
    session: usageTotals(totalUsage(currentUsage)),
    allTime: usageTotals(totalUsage(allTime)),
    providers,
  };
}

registerProviderUsageProvider({
  latestContextUsageSnapshotFromSessionRecords: (records, provider, usageRecords) =>
    latestContextUsageSnapshotFromSessionRecords(
      records as never,
      provider as never,
      usageRecords as never,
    ),
  usageByProviderFromRecords: (records) => usageByProviderFromRecords(records),
  fetchUsageSnapshot: (currentUsage) => fetchUsageSnapshot(currentUsage as UsageByProvider),
});
