import { useEffect, useState } from "react";
import { pricingFor } from "@/engine/contract/pricing.ts";
import { fetchDeepseekBalance } from "@/engine/providers/deepseek/usage.ts";
import { costFor, formatCost } from "@/engine/session/usage/pricing.ts";
import {
  type ProviderUsageTotals,
  providerContextWarning,
  totalProviderTokens,
} from "@/engine/session/usage/provider.ts";
import { Box, Text } from "@/ink";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import {
  type AnthropicUsageLoadState,
  type AntigravityUsageLoadState,
  type CodexUsageLoadState,
  type DeepseekBalanceLoadState,
  formatCount,
  type KimiUsageLoadState,
  kimiRows,
  kimiUsageLimit,
  type PlanQuotaLoadState,
} from "@/ui/panels/usage/data";
import { LimitBar } from "@/ui/panels/usage/views";
import { Color } from "@/ui/theme/theme.ts";

export function CodexPlanUsage({
  usageState,
  maxContentWidth,
}: {
  usageState: CodexUsageLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  const codexUsage = usageState.data;
  if (!codexUsage) {
    if (usageState.status === "error") {
      return <Text color={Color.error}>{codexUsageErrorMessage(usageState.message)}</Text>;
    }
    if (usageState.status === "loaded") {
      return <Text color={Color.muted}>/usage is not available for this Codex account.</Text>;
    }
    return <Text color={Color.muted}>Loading usage data...</Text>;
  }
  // Product window is weekly-only; primary remains on the wire for routing but
  // is not a separate plan bar.
  const weekly = codexUsage.secondary ?? codexUsage.primary;
  const spark = codexUsage.additional?.find((limit) =>
    `${limit.id ?? ""} ${limit.label}`.toLowerCase().includes("spark"),
  );
  return (
    <Box flexDirection="column">
      <LimitBar title="Weekly" limit={weekly} maxContentWidth={maxContentWidth} />
      {spark?.secondary && (
        <LimitBar
          title="Weekly · Spark"
          limit={spark.secondary}
          maxContentWidth={maxContentWidth}
        />
      )}
      {usageState.status === "error" && (
        <Box marginTop={1}>
          <Text color={Color.warning}>{codexUsageErrorMessage(usageState.message)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function AntigravityPlanUsage({
  usageState,
  provider,
  model,
  usage,
  offlineUsage,
  maxContentWidth,
}: {
  usageState: AntigravityUsageLoadState;
  provider: ProviderId;
  model: string;
  usage: ProviderUsageTotals;
  offlineUsage: ProviderUsageTotals;
  maxContentWidth: number;
}): React.JSX.Element {
  const localFallback = (
    <Box flexDirection="column">
      <Text color={Color.muted}>Live quota unavailable for this Antigravity account.</Text>
      <Box marginTop={1}>
        <LocalProviderUsage
          provider={provider}
          model={model}
          usage={usage}
          offlineUsage={offlineUsage}
        />
      </Box>
    </Box>
  );
  if (!usageState.data) {
    if (usageState.status === "error") {
      return <Text color={Color.error}>{antigravityUsageErrorMessage(usageState.message)}</Text>;
    }
    if (usageState.status === "loaded") {
      return localFallback;
    }
    return <Text color={Color.muted}>Loading usage data...</Text>;
  }
  if (usageState.data.groups.length === 0) {
    return localFallback;
  }
  return (
    <Box flexDirection="column">
      {usageState.status === "loading" && <Text color={Color.muted}>Refreshing…</Text>}
      {usageState.data.groups.map((group) => (
        <Box key={group.displayName} flexDirection="column">
          <Text bold>{group.displayName}</Text>
          {!!group.description && <Text color={Color.muted}>{group.description}</Text>}
          <Box flexDirection="column" marginTop={1}>
            {group.buckets.map((bucket) => (
              <LimitBar
                key={bucket.bucketId}
                title={bucket.displayName}
                limit={{
                  utilization: bucket.utilization,
                  resetsAt: bucket.resetsAt,
                }}
                maxContentWidth={maxContentWidth}
              />
            ))}
          </Box>
        </Box>
      ))}
      {usageState.status === "error" && (
        <Box marginTop={1}>
          <Text color={Color.warning}>{antigravityUsageErrorMessage(usageState.message)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function antigravityUsageErrorMessage(message: string): string {
  if (
    /not logged in|login --provider antigravity|HTTP 401|antigravity refresh 40[013]/i.test(message)
  ) {
    return "Antigravity is not logged in. Run /login antigravity to view usage.";
  }
  return `Unable to update Antigravity usage: ${message}`;
}

export function KimiPlanUsage({
  usageState,
  maxContentWidth,
}: {
  usageState: KimiUsageLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  const rows = usageState.data ? kimiRows(usageState.data) : [];
  if (rows.length === 0) {
    if (usageState.status === "error") {
      return <Text color={Color.error}>{kimiUsageErrorMessage(usageState.message)}</Text>;
    }
    if (usageState.status === "loaded") {
      return <Text color={Color.muted}>No usage data available.</Text>;
    }
    return <Text color={Color.muted}>Loading usage data...</Text>;
  }
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <LimitBar
          key={row.label}
          title={row.label}
          limit={kimiUsageLimit(row)}
          maxContentWidth={maxContentWidth}
        />
      ))}
      {usageState.status === "error" && (
        <Box marginTop={1}>
          <Text color={Color.warning}>{kimiUsageErrorMessage(usageState.message)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function AnthropicPlanUsage({
  usageState,
  maxContentWidth,
  marginTop = 0,
}: {
  usageState: AnthropicUsageLoadState;
  maxContentWidth: number;
  marginTop?: number | undefined;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <AnthropicUsageBody state={usageState} maxContentWidth={maxContentWidth} />
    </Box>
  );
}

export function codexUsageErrorMessage(message: string): string {
  if (
    /not logged in|login --provider codex|codex account authentication required|HTTP 401|codex refresh 40[013]/i.test(
      message,
    )
  ) {
    return "Codex is not logged in. Run /login codex to view usage.";
  }
  return `Unable to update Codex usage: ${message}`;
}

export function kimiUsageErrorMessage(message: string): string {
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

export function AnthropicUsageBody({
  state,
  maxContentWidth,
}: {
  state: AnthropicUsageLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  if (state.status === "error") {
    return <Text color={Color.error}>Error: {state.message}</Text>;
  }
  if (state.status !== "loaded") {
    return <Text color={Color.muted}>Loading usage data...</Text>;
  }
  if (!state.data) {
    return <Text color={Color.muted}>/usage is only available for subscription plans.</Text>;
  }
  const data = state.data;
  const limits = [
    { title: "Current session", limit: data.fiveHour },
    { title: "Current week (all models)", limit: data.sevenDay },
    { title: "Current week (Fable)", limit: data.sevenDayFable },
  ].filter((item) => item.limit !== undefined && item.limit !== null);

  return (
    <Box flexDirection="column">
      {limits.length === 0 && (
        <Text color={Color.muted}>/usage is only available for subscription plans.</Text>
      )}
      {limits.map(({ title, limit }) => (
        <LimitBar key={title} title={title} limit={limit} maxContentWidth={maxContentWidth} />
      ))}
    </Box>
  );
}

export function KimiCombinedUsage({
  usageState,
  maxContentWidth,
}: {
  usageState: KimiUsageLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <KimiPlanUsage usageState={usageState} maxContentWidth={maxContentWidth} />
    </Box>
  );
}

export function DeepseekCombinedUsage({
  localUsage,
  offlineUsage,
  model,
  maxContentWidth,
}: {
  localUsage: ProviderUsageTotals;
  offlineUsage: ProviderUsageTotals;
  model: string;
  maxContentWidth: number;
}): React.JSX.Element {
  const [balanceState, setBalanceState] = useState<DeepseekBalanceLoadState>({
    status: "idle",
    data: null,
  });
  useEffect(() => {
    let alive = true;
    setBalanceState((current) => {
      if (current.status !== "idle") return current;
      void fetchDeepseekBalance()
        .then((data) => {
          if (alive) setBalanceState({ status: "loaded", data });
        })
        .catch((err) => {
          if (!alive) return;
          const message = err instanceof Error ? err.message : String(err);
          setBalanceState((latest) => ({
            status: "error",
            data: latest.data,
            message,
          }));
        });
      return { status: "loading", data: current.data };
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Box flexDirection="column">
      <DeepseekBalanceBlock balanceState={balanceState} maxContentWidth={maxContentWidth} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>Session totals</Text>
        <Text color={Color.muted}>
          {formatCount(totalProviderTokens(localUsage))} tokens this session ·{" "}
          {formatCount(totalProviderTokens(offlineUsage))} all time · {model}
        </Text>
      </Box>
    </Box>
  );
}

export function DeepseekBalanceBlock({
  balanceState,
  maxContentWidth: _maxContentWidth,
}: {
  balanceState: DeepseekBalanceLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  if (!balanceState.data) {
    if (balanceState.status === "error") {
      return <Text color={Color.error}>{deepseekBalanceErrorMessage(balanceState.message)}</Text>;
    }
    if (balanceState.status === "loaded") {
      return <Text color={Color.muted}>Balance unavailable for this DeepSeek account.</Text>;
    }
    return <Text color={Color.muted}>Loading balance…</Text>;
  }
  const data = balanceState.data;
  const main = data.rows[0];
  return (
    <Box flexDirection="column">
      <Text bold>Wallet</Text>
      {main ? (
        <>
          <Text>
            <Text color={Color.muted}>Balance </Text>
            <Text color={data.isAvailable ? Color.primary : Color.warning} bold>
              {formatBalance(main.totalBalance, main.currency)}
            </Text>
          </Text>
          {!data.isAvailable && (
            <Text color={Color.warning}>Account is not available for inference.</Text>
          )}
        </>
      ) : (
        <Text color={Color.muted}>No balance entries returned.</Text>
      )}
      {balanceState.status === "error" && (
        <Box marginTop={1}>
          <Text color={Color.warning}>{deepseekBalanceErrorMessage(balanceState.message)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function deepseekBalanceErrorMessage(message: string): string {
  if (/HTTP 401|unauthorized|forbidden|HTTP 40[03]/i.test(message)) {
    return "DeepSeek key cannot read balance. Check key permissions.";
  }
  return `Unable to fetch DeepSeek balance: ${message}`;
}

export function formatBalance(value: number, currency: string): string {
  const symbol = currencySymbol(currency);
  if (symbol) return `${symbol}${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${currency}`;
}

export function currencySymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

export function LocalProviderUsage({
  provider,
  model,
  usage,
  offlineUsage,
}: {
  provider: ProviderId;
  model: string;
  usage: ProviderUsageTotals;
  offlineUsage: ProviderUsageTotals;
}): React.JSX.Element {
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

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Current session</Text>
        <Text color={Color.muted}>{currentSubtext}</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>All time</Text>
        <Text color={Color.muted}>{allTimeSubtext}</Text>
      </Box>
      {warning && (
        <Box marginTop={1}>
          <Text color={warning.severity === "error" ? Color.error : Color.warning}>
            {warning.message}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function planQuotaErrorMessage(message: string): string {
  if (/HTTP 401|unauthorized|forbidden|HTTP 40[13]/i.test(message)) {
    return "Key cannot read plan quota. Check key permissions.";
  }
  return `Unable to fetch plan quota: ${message}`;
}

export function PlanQuotaUsage({
  usageState,
  maxContentWidth,
}: {
  usageState: PlanQuotaLoadState;
  provider: ProviderId;
  maxContentWidth: number;
}): React.JSX.Element {
  const data = usageState.data;

  return (
    <Box flexDirection="column">
      {!data && usageState.status === "loading" && (
        <Text color={Color.muted}>Loading plan quota…</Text>
      )}
      {!data && usageState.status === "error" && (
        <Text color={Color.warning}>{planQuotaErrorMessage(usageState.message)}</Text>
      )}
      {!data && usageState.status === "loaded" && (
        <Text color={Color.muted}>Plan quota unavailable for this account.</Text>
      )}
      {!!data && (
        <Box flexDirection="column">
          {data.windows.map((win) => (
            <LimitBar
              key={`${win.label}-${win.limit.resetsAt ?? ""}`}
              title={win.label}
              limit={win.limit}
              maxContentWidth={maxContentWidth}
              extraSubtext={win.detail}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
