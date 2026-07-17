import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import type {
  AnthropicRateLimitUsage,
  AnthropicUsage,
} from "@/engine/providers/anthropic/usage.ts";
import type { AntigravityUsage } from "@/engine/providers/antigravity/usage.ts";
import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { DeepseekBalance } from "@/engine/providers/deepseek/usage.ts";
import { type KimiUsage, type KimiUsageRow } from "@/engine/providers/kimi/usage.ts";
import type { RoutingUsageSnapshot } from "@/engine/session/usage/limits.ts";
import type { PlanQuotaData } from "@/engine/session/usage/plan-quota.ts";
import {
  emptyProviderUsage,
  type ProviderUsageTotals,
  totalProviderTokens,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import type { ProviderCooldownRecord } from "@/engine/session/usage/provider-health.ts";
import { QUOTA_BLOCK_PCT } from "@/engine/session/usage/thresholds.ts";
import { type Color as InkColor } from "@/ink";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { Color } from "@/ui/theme/theme.ts";

export type UsageTab = "general" | ProviderId;
export type UsageInitialTab = "general" | "per_provider" | "current" | ProviderId;

export type LoadState<T> =
  | { status: "idle"; data: T | null }
  | { status: "loading"; data: T | null }
  | { status: "loaded"; data: T | null }
  | { status: "error"; data: T | null; message: string };

export type AnthropicUsageLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: AnthropicUsage | null }
  | { status: "error"; message: string };

export type CodexUsageLoadState = LoadState<CodexUsage>;
export type AntigravityUsageLoadState = LoadState<AntigravityUsage>;
export type PlanQuotaLoadState = LoadState<PlanQuotaData>;
export type KimiUsageLoadState = LoadState<KimiUsage>;
export type DeepseekBalanceLoadState = LoadState<DeepseekBalance>;

const XAI_QUOTA_DISPLAY_PCT = 95;

export interface UsageRow {
  label: string;
  value: string;
  muted?: boolean | undefined;
  valueColor?: InkColor | undefined;
}

export function activityRows(usage: ProviderUsageTotals): UsageRow[] {
  return [
    { label: "Requests", value: formatCount(usage.requestCount) },
    { label: "Input tokens", value: formatCount(usage.inputTokens) },
    { label: "Output tokens", value: formatCount(usage.outputTokens) },
    { label: "Thinking tokens", value: formatCount(usage.thoughtTokens) },
    { label: "Total tokens", value: formatCount(totalProviderTokens(usage)) },
  ];
}

export function providerRows(current: UsageByProvider, allTime: UsageByProvider): UsageRow[] {
  const ids = listProviderConfigs()
    .map((c) => c.provider.id)
    .filter((id) => id !== "openai");
  return ids.map((provider) => {
    const currentUsage = current[provider] ?? emptyProviderUsage();
    const allTimeUsage = allTime[provider] ?? emptyProviderUsage();
    return {
      label: getProviderConfig(provider)?.provider.label ?? provider,
      value: `${formatTokenCount(totalProviderTokens(currentUsage))} current · ${formatTokenCount(totalProviderTokens(allTimeUsage))} all time`,
      muted: totalProviderTokens(currentUsage) === 0 && totalProviderTokens(allTimeUsage) === 0,
    };
  });
}

export function cooldownRows(cooldowns: ProviderCooldownRecord[]): UsageRow[] {
  if (cooldowns.length === 0) return [];
  return [
    {
      label: "Cooldowns",
      value: cooldowns.map(formatCooldownRecord).join(" · "),
      muted: true,
    },
  ];
}

export function blockedRoutingRows(snapshot: RoutingUsageSnapshot): UsageRow[] {
  const blocks: string[] = [];
  const warnings: string[] = [];
  for (const [providerId, state] of Object.entries(snapshot.byProvider)) {
    if (!state) continue;
    const label = getProviderConfig(providerId as ProviderId)?.provider.label ?? providerId;
    if (state.balanceStatus === "exhausted") {
      blocks.push(`${label} balance exhausted`);
      continue;
    }
    const tracked = state.trackingStatus === "tracked" || state.trackingStatus === "partial";
    const utilization = state.utilizationPct;
    const isRoutingBlock =
      tracked &&
      state.balanceStatus !== "available" &&
      utilization !== undefined &&
      utilization >= QUOTA_BLOCK_PCT;
    if (isRoutingBlock) {
      blocks.push(`${label} ${Math.floor(utilization)}%`);
      continue;
    }
    if (
      providerId === "xai" &&
      tracked &&
      utilization !== undefined &&
      utilization >= XAI_QUOTA_DISPLAY_PCT &&
      utilization < QUOTA_BLOCK_PCT
    ) {
      warnings.push(`${label} ${Math.floor(utilization)}%`);
    }
  }
  const rows: UsageRow[] = [];
  if (blocks.length > 0) {
    rows.push({ label: "Quota blocks", value: blocks.join(" · "), valueColor: Color.error });
  }
  if (warnings.length > 0) {
    rows.push({ label: "Quota warnings", value: warnings.join(" · "), valueColor: Color.warning });
  }
  return rows;
}

function formatCooldownRecord(record: ProviderCooldownRecord): string {
  const provider = getProviderConfig(record.provider)?.provider.label ?? record.provider;
  const scope = record.model === null ? provider : `${provider}/${record.model}`;
  const reset = formatUsageResetText(new Date(record.untilEpochMs).toISOString(), true, true);
  return `${scope} ${record.reason}${reset ? ` until ${reset}` : ""}`;
}

export function kimiRows(usage: KimiUsage): KimiUsageRow[] {
  return [usage.summary, ...usage.limits].filter((row): row is KimiUsageRow => row !== undefined);
}

export function kimiUsageLimit(row: KimiUsageRow): AnthropicRateLimitUsage {
  const utilization = row.limit > 0 ? (Math.max(0, row.used) / row.limit) * 100 : 0;
  const resetsAt =
    row.resetsAt ??
    (row.resetInSeconds && row.resetInSeconds > 0
      ? new Date(Date.now() + row.resetInSeconds * 1000).toISOString()
      : null);
  return { utilization, resetsAt };
}

export function formatUsageResetText(
  value: string | null,
  showTimezone: boolean,
  showTime: boolean,
): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const now = new Date();
  const minutes = date.getMinutes();
  const hoursUntilReset = (date.getTime() - now.getTime()) / 3_600_000;
  const timeZone = getShortTimeZone(date);
  if (hoursUntilReset > 24) {
    const resetText = showTime
      ? formatResetDateTime(date, now, minutes)
      : formatResetDate(date, now);
    return withTimezone(resetText, showTimezone, timeZone);
  }
  return withTimezone(
    date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: minutes === 0 ? undefined : "2-digit",
      hour12: true,
    }),
    showTimezone,
    timeZone,
  );
}

export function formatResetDate(date: Date, now: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function formatResetDateTime(date: Date, now: Date, minutes: number): string {
  const timeText = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: minutes === 0 ? undefined : "2-digit",
    hour12: true,
  });
  return `${formatResetDate(date, now)} at ${timeText}`;
}

export function withTimezone(value: string, showTimezone: boolean, timeZone: string): string {
  const formatted = value.replace(/ ([AP]M)/i, (_match, ampm: string) => ampm.toLowerCase());
  return showTimezone ? `${formatted} (${timeZone})` : formatted;
}

import { getShortTimeZone } from "@/kernel/std/intl.ts";

export function initialTabIndex(
  tabs: { id: UsageTab; label: string }[],
  initialTab: UsageInitialTab,
  current: ProviderId,
): number {
  if (initialTab === "general") return 0;
  const target: UsageTab =
    initialTab === "per_provider" || initialTab === "current" ? current : initialTab;
  const idx = tabs.findIndex((tab) => tab.id === target);
  return idx >= 0 ? idx : 0;
}

export function emptyUsage(): ProviderUsageTotals {
  return emptyProviderUsage();
}

export function totalUsage(usageByProvider: UsageByProvider): ProviderUsageTotals {
  const total = emptyUsage();
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

export function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

export function formatTokenCount(value: number): string {
  return `${formatCount(value)} tokens`;
}

export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function usageFooterHints({
  activeTab,
  canScroll,
  canRefresh,
}: {
  activeTab: UsageTab;
  canScroll: boolean;
  canRefresh: boolean;
}): [string, string][] {
  void activeTab;
  const hints: [string, string][] = [["←/→", "switch tabs"]];
  if (canScroll) {
    hints.push(["↑/↓", "scroll"]);
  }
  if (canRefresh) {
    hints.push(["r", "refresh"]);
  }
  hints.push(["Esc", "close"]);
  return hints;
}
