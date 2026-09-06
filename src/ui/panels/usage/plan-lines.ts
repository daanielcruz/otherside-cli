import { pricingFor } from "@/engine/contract/pricing.ts";
import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import { costFor, formatCost } from "@/engine/session/usage/pricing.ts";
import {
  type ProviderUsageTotals,
  providerContextWarning,
  totalProviderTokens,
} from "@/engine/session/usage/provider.ts";
import { QUOTA_BLOCK_RATIO, QUOTA_WARN_RATIO } from "@/engine/session/usage/thresholds.ts";
import { clamp } from "@/kernel/std/math.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import {
  type AnthropicUsageLoadState,
  type AntigravityUsageLoadState,
  type CodexUsageLoadState,
  type DeepseekBalanceLoadState,
  formatCount,
  formatUsageResetText,
  type KimiUsageLoadState,
  kimiRows,
  kimiUsageLimit,
  type PlanQuotaLoadState,
} from "@/ui/panels/usage/data.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

function mutedLine(text: string): string {
  return renderTextWithStyles(text, { color: Color.muted });
}

function errorLine(text: string): string {
  return renderTextWithStyles(text, { color: Color.error });
}

function warningLine(text: string): string {
  return renderTextWithStyles(text, { color: Color.warning });
}

function boldLine(text: string): string {
  return renderTextWithStyles(text, { color: Color.text, bold: true });
}

function usageBarColor(ratio: number): TerminalColor {
  if (ratio <= 0) return Color.subtle;
  if (ratio >= QUOTA_BLOCK_RATIO) return Color.error;
  if (ratio >= QUOTA_WARN_RATIO) return Color.warning;
  return Color.panelAccent;
}

function usageBarSegment(ratio: number, width: number): string {
  const filled = ratio <= 0 ? 0 : Math.max(1, Math.min(width, Math.round(ratio * width)));
  const empty = Math.max(0, width - filled);
  let segment = "";
  if (filled > 0) {
    segment += renderTextWithStyles(Glyph.block.repeat(filled), { color: usageBarColor(ratio) });
  }
  if (empty > 0) {
    segment += renderTextWithStyles(Glyph.blockLight.repeat(empty), { color: Color.subtle });
  }
  return segment;
}

function limitBarLines(
  title: string,
  limit: AnthropicRateLimitUsage | null | undefined,
  maxContentWidth: number,
  extraSubtext?: string,
  showTimeInReset = true,
): string[] {
  if (!limit || limit.utilization === null) return [];
  const ratio = clamp(limit.utilization / 100, 0, 1);
  const usedText = `${Math.floor(limit.utilization)}% used`;
  const reset = formatUsageResetText(limit.resetsAt, true, showTimeInReset);
  const subtext = [extraSubtext, reset && `Resets ${reset}`].filter(Boolean).join(" · ");
  const barWidth = maxContentWidth >= 62 ? 50 : Math.max(12, Math.min(40, maxContentWidth - 8));

  const lines = [
    boldLine(title),
    usageBarSegment(ratio, barWidth) + renderTextWithStyles(` ${usedText}`, { color: Color.text }),
  ];
  if (subtext.length > 0) lines.push(mutedLine(subtext));
  lines.push("");
  return lines;
}

export function anthropicPlanLines(
  state: AnthropicUsageLoadState,
  maxContentWidth: number,
): string[] {
  const data = state.data;
  if (!data) {
    if (state.status === "error") return [errorLine(`Error: ${state.message}`)];
    if (state.status === "loaded") {
      return [mutedLine("/usage is only available for subscription plans.")];
    }
    return [mutedLine("Loading usage data...")];
  }
  const limits = [
    { title: "Current session", limit: data.fiveHour },
    { title: "Current week (all models)", limit: data.sevenDay },
    { title: "Current week (Fable)", limit: data.sevenDayFable },
  ].filter((item) => item.limit !== undefined && item.limit !== null);

  const lines: string[] = [];
  if (limits.length === 0) {
    lines.push(mutedLine("/usage is only available for subscription plans."));
  }
  for (const { title, limit } of limits) {
    lines.push(...limitBarLines(title, limit, maxContentWidth));
  }
  if (state.status === "error") {
    lines.push(warningLine(`Error: ${state.message}`));
  }
  return trimTrailingBlank(lines);
}

export function codexPlanLines(state: CodexUsageLoadState, maxContentWidth: number): string[] {
  const codexUsage = state.data;
  if (!codexUsage) {
    if (state.status === "error") return [errorLine(codexUsageErrorMessage(state.message))];
    if (state.status === "loaded") {
      return [mutedLine("/usage is not available for this Codex account.")];
    }
    return [mutedLine("Loading usage data...")];
  }
  const weekly = codexUsage.secondary ?? codexUsage.primary;
  const spark = codexUsage.additional?.find((limit) =>
    `${limit.id ?? ""} ${limit.label}`.toLowerCase().includes("spark"),
  );
  const lines = [
    ...limitBarLines("Weekly", weekly, maxContentWidth),
    ...(spark?.secondary ? limitBarLines("Weekly · Spark", spark.secondary, maxContentWidth) : []),
  ];
  if (state.status === "error") {
    lines.push(warningLine(codexUsageErrorMessage(state.message)));
  }
  return trimTrailingBlank(lines);
}

export function antigravityPlanLines(
  state: AntigravityUsageLoadState,
  provider: ProviderId,
  model: string,
  usage: ProviderUsageTotals,
  offlineUsage: ProviderUsageTotals,
  maxContentWidth: number,
  contentWidth: number,
): string[] {
  const localFallback = (): string[] => [
    mutedLine("Live quota unavailable for this Antigravity account."),
    "",
    ...localProviderLines(provider, model, usage, offlineUsage, contentWidth),
  ];

  if (!state.data) {
    if (state.status === "error") return [errorLine(antigravityUsageErrorMessage(state.message))];
    if (state.status === "loaded") return localFallback();
    return [mutedLine("Loading usage data...")];
  }

  const creditBalance = state.data.creditBalance;
  const creditLine =
    typeof creditBalance === "number"
      ? renderTextWithStyles(`Google One AI credits: ${creditBalance}`, {
          color: creditBalance === 0 ? Color.warning : Color.muted,
        })
      : null;

  if (state.data.groups.length === 0) {
    const lines = localFallback();
    if (creditLine) {
      lines.push("");
      lines.push(creditLine);
    }
    return lines;
  }

  const lines: string[] = [];
  if (state.status === "loading") lines.push(mutedLine("Refreshing…"));
  for (const group of state.data.groups) {
    lines.push(boldLine(group.displayName));
    if (group.description) lines.push(mutedLine(group.description));
    lines.push("");
    for (const bucket of group.buckets) {
      lines.push(
        ...limitBarLines(
          bucket.displayName,
          { utilization: bucket.utilization, resetsAt: bucket.resetsAt },
          maxContentWidth,
        ),
      );
    }
  }
  if (creditLine) lines.push(creditLine);
  if (state.status === "error") {
    lines.push(warningLine(antigravityUsageErrorMessage(state.message)));
  }
  return trimTrailingBlank(lines);
}

export function kimiPlanLines(state: KimiUsageLoadState, maxContentWidth: number): string[] {
  const rows = state.data ? kimiRows(state.data) : [];
  if (rows.length === 0) {
    if (state.status === "error") return [errorLine(kimiUsageErrorMessage(state.message))];
    if (state.status === "loaded") return [mutedLine("No usage data available.")];
    return [mutedLine("Loading usage data...")];
  }
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(...limitBarLines(row.label, kimiUsageLimit(row), maxContentWidth));
  }
  if (state.status === "error") {
    lines.push(warningLine(kimiUsageErrorMessage(state.message)));
  }
  return trimTrailingBlank(lines);
}

export function planQuotaLines(state: PlanQuotaLoadState, maxContentWidth: number): string[] {
  const data = state.data;
  if (!data) {
    if (state.status === "loading") return [mutedLine("Loading plan quota…")];
    if (state.status === "error") return [warningLine(planQuotaErrorMessage(state.message))];
    if (state.status === "loaded") {
      return [mutedLine("Plan quota unavailable for this account.")];
    }
    return [mutedLine("Loading plan quota…")];
  }
  const lines: string[] = [];
  for (const win of data.windows) {
    lines.push(...limitBarLines(win.label, win.limit, maxContentWidth, win.detail));
  }
  return trimTrailingBlank(lines);
}

export function deepseekLines(
  balanceState: DeepseekBalanceLoadState,
  localUsage: ProviderUsageTotals,
  offlineUsage: ProviderUsageTotals,
  model: string,
  contentWidth: number,
): string[] {
  const lines = [...deepseekBalanceLines(balanceState)];
  lines.push("");
  lines.push(boldLine("Session totals"));
  lines.push(
    mutedLine(
      `${formatCount(totalProviderTokens(localUsage))} tokens this session · ${formatCount(totalProviderTokens(offlineUsage))} all time · ${model}`,
    ),
  );
  void contentWidth;
  return lines;
}

function deepseekBalanceLines(balanceState: DeepseekBalanceLoadState): string[] {
  if (!balanceState.data) {
    if (balanceState.status === "error") {
      return [errorLine(deepseekBalanceErrorMessage(balanceState.message))];
    }
    if (balanceState.status === "loaded") {
      return [mutedLine("Balance unavailable for this DeepSeek account.")];
    }
    return [mutedLine("Loading balance…")];
  }
  const data = balanceState.data;
  const main = data.rows[0];
  const lines = [boldLine("Wallet")];
  if (main) {
    lines.push(
      renderTextWithStyles("Balance ", { color: Color.muted }) +
        renderTextWithStyles(formatBalance(main.totalBalance, main.currency), {
          color: data.isAvailable ? Color.primary : Color.warning,
          bold: true,
        }),
    );
    if (!data.isAvailable) {
      lines.push(warningLine("Account is not available for inference."));
    }
  } else {
    lines.push(mutedLine("No balance entries returned."));
  }
  if (balanceState.status === "error") {
    lines.push(warningLine(deepseekBalanceErrorMessage(balanceState.message)));
  }
  return lines;
}

export function localProviderLines(
  provider: ProviderId,
  model: string,
  usage: ProviderUsageTotals,
  offlineUsage: ProviderUsageTotals,
  _contentWidth: number,
): string[] {
  const warning = providerContextWarning(provider, model, totalProviderTokens(usage));
  const pricing = pricingFor(provider, model);
  const cost = pricing ? costFor(usage, pricing) : null;
  const offlineCost = pricing ? costFor(offlineUsage, pricing) : null;

  const currentSubtext = [
    `${formatCount(totalProviderTokens(usage))} tokens`,
    cost && formatCost(cost.total),
    model,
  ]
    .filter(Boolean)
    .join(" · ");
  const allTimeSubtext = [
    `${formatCount(totalProviderTokens(offlineUsage))} tokens`,
    offlineCost && formatCost(offlineCost.total),
    offlineUsage.lastModel ?? model,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [
    boldLine("Current session"),
    mutedLine(currentSubtext),
    "",
    boldLine("All time"),
    mutedLine(allTimeSubtext),
  ];
  if (warning) {
    lines.push("");
    lines.push(
      renderTextWithStyles(warning.message, {
        color: warning.severity === "error" ? Color.error : Color.warning,
      }),
    );
  }
  return lines;
}

function codexUsageErrorMessage(message: string): string {
  if (
    /not logged in|login --provider codex|codex account authentication required|HTTP 401|codex refresh 40[013]/i.test(
      message,
    )
  ) {
    return "Codex is not logged in. Run /login codex to view usage.";
  }
  return `Unable to update Codex usage: ${message}`;
}

function antigravityUsageErrorMessage(message: string): string {
  if (
    /not logged in|login --provider antigravity|HTTP 401|antigravity refresh 40[013]/i.test(message)
  ) {
    return "Antigravity is not logged in. Run /login antigravity to view usage.";
  }
  return `Unable to update Antigravity usage: ${message}`;
}

function kimiUsageErrorMessage(message: string): string {
  if (/no kimi API key|not configured|missing|login --provider kimi/i.test(message)) {
    return "Kimi is not configured. Run /login kimi to view usage.";
  }
  if (/HTTP 401|unauthorized|authorization failed/i.test(message)) {
    return "Authorization failed. Please check your API key.";
  }
  if (/HTTP 404|not found/i.test(message)) {
    return "Usage endpoint not available. Try Kimi for Coding.";
  }
  return `Unable to update Kimi usage: ${message}`;
}

function deepseekBalanceErrorMessage(message: string): string {
  if (/HTTP 401|unauthorized|forbidden|HTTP 40[03]/i.test(message)) {
    return "DeepSeek key cannot read balance. Check key permissions.";
  }
  return `Unable to fetch DeepSeek balance: ${message}`;
}

function planQuotaErrorMessage(message: string): string {
  if (/HTTP 401|unauthorized|forbidden|HTTP 40[13]/i.test(message)) {
    return "Key cannot read plan quota. Check key permissions.";
  }
  return `Unable to fetch plan quota: ${message}`;
}

function formatBalance(value: number, currency: string): string {
  const symbol = currencySymbol(currency);
  if (symbol) return `${symbol}${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${currency}`;
}

function currencySymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
