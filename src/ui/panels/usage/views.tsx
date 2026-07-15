import type { ReactNode } from "react";
import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import { QUOTA_BLOCK_RATIO, QUOTA_WARN_RATIO } from "@/engine/session/usage/thresholds.ts";
import { Box, type Color as InkColor, Text } from "@/ink";
import { clamp } from "@/kernel/std/math.ts";
import { FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { formatUsageResetText, type UsageRow } from "@/ui/panels/usage/data";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export function LimitBar({
  title,
  limit,
  maxContentWidth,
  extraSubtext,
  showTimeInReset = true,
}: {
  title: string;
  limit: AnthropicRateLimitUsage | null | undefined;
  maxContentWidth: number;
  extraSubtext?: string | undefined;
  showTimeInReset?: boolean | undefined;
}): React.JSX.Element | null {
  if (!limit || limit.utilization === null) return null;
  const ratio = clamp(limit.utilization / 100, 0, 1);
  const usedText = `${Math.floor(limit.utilization)}% used`;
  const reset = formatUsageResetText(limit.resetsAt, true, showTimeInReset);
  const subtext = [extraSubtext, reset && `Resets ${reset}`].filter(Boolean).join(" · ");
  const barWidth = maxContentWidth >= 62 ? 50 : Math.max(12, Math.min(40, maxContentWidth - 8));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Box>
        <UsageBar ratio={ratio} width={barWidth} />
        <Text> {usedText}</Text>
      </Box>
      {subtext.length > 0 && <Text color={Color.muted}>{subtext}</Text>}
    </Box>
  );
}

export function usageBarColor(ratio: number): InkColor {
  if (ratio <= 0) return Color.subtle;
  if (ratio >= QUOTA_BLOCK_RATIO) return Color.error;
  if (ratio >= QUOTA_WARN_RATIO) return Color.warning;
  return Color.primaryGlow;
}

export function UsageBar({ ratio, width }: { ratio: number; width: number }): React.JSX.Element {
  const filled = ratio <= 0 ? 0 : Math.max(1, Math.min(width, Math.round(ratio * width)));
  const empty = Math.max(0, width - filled);
  return (
    <>
      {filled > 0 && <Text color={usageBarColor(ratio)}>{Glyph.block.repeat(filled)}</Text>}
      {empty > 0 && <Text color={Color.subtle}>{Glyph.blockLight.repeat(empty)}</Text>}
    </>
  );
}

export function UsageSection({
  title,
  children,
  marginTop = 0,
}: {
  title: string;
  children: ReactNode;
  marginTop?: number | undefined;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Text bold>{title}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

export function UsageRows({ rows }: { rows: UsageRow[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <FooterPanelRow
          key={row.label}
          label={row.label}
          value={row.value}
          muted={row.muted}
          valueColor={row.valueColor}
          width={22}
        />
      ))}
    </Box>
  );
}
