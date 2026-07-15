import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import { applyQuotaWarning, type QuotaCandidate } from "@/engine/session/usage/quota-warning.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export interface PlanQuotaWindow {
  label: string;
  limit: AnthropicRateLimitUsage;
  detail?: string | undefined;
}

export interface PlanQuotaData {
  level: string | null;
  windows: PlanQuotaWindow[];
}

export function applyPlanQuotaWarning(
  provider: ProviderId,
  usage: PlanQuotaData | null,
  providerLabel: string,
): void {
  if (!usage) {
    applyQuotaWarning(provider, []);
    return;
  }
  const candidates: QuotaCandidate[] = [];
  for (const window of usage.windows) {
    if (window.limit.utilization === null || window.limit.utilization === undefined) continue;
    candidates.push({
      label: planQuotaLabel(providerLabel, window.label),
      utilization: window.limit.utilization,
      resetsAt: window.limit.resetsAt,
      provider,
      trackingStatus: "tracked",
    });
  }
  applyQuotaWarning(provider, candidates);
}

function planQuotaLabel(providerLabel: string, windowLabel: string): string {
  if (/limit$/i.test(windowLabel)) return `${providerLabel} ${windowLabel}`;
  return `${providerLabel} ${windowLabel} limit`;
}
