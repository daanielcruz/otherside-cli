import { memo, useEffect, useMemo, useState } from "react";
import type { Color as InkColor } from "@/ink";
import { Box, Text, useTerminalDimensions } from "@/ink";
import type { StatuslineConfig } from "@/kernel/config/config.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import {
  buildStatuslineInput,
  fastModeStatuslineSuffix,
  renderNativeStatusline,
  runStatuslineCommand,
} from "@/ui/chrome/status/line-input.ts";
import { Color } from "@/ui/theme/theme.ts";

export interface StatuslineProps {
  state: BrokerState;
  sessionId: string;
  version: string;
  config?: StatuslineConfig | undefined;
  cwd: string;
  width: number;
  refreshKey: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  cost?: number | undefined;
  totalTokens?: number | undefined;
  tokensWarning?: { message: string; severity: "warning" | "error" } | undefined;
  goalLabel?: string | undefined;
  autoCompactRemainingPct?: number | undefined;
}

interface StatusSegment {
  key: string;
  text: string;
  color: InkColor;
  dim?: boolean;
}

interface StatusChainProps {
  segments: StatusSegment[];
}

function StatusChain({ segments }: StatusChainProps): React.JSX.Element {
  return (
    <Text>
      {segments.map((segment, index) => (
        <Text key={segment.key}>
          {index > 0 && <Text color={Color.muted}> · </Text>}
          <Text color={segment.color} dim={segment.dim === true}>
            {segment.text}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

function rightStatusText(
  tokensWarning: StatuslineProps["tokensWarning"],
  totalTokens: number | undefined,
): string | null {
  if (tokensWarning) return tokensWarning.message;
  if (totalTokens !== undefined && totalTokens > 0) return `${totalTokens} tokens`;
  return null;
}

function StatuslineImpl({
  state,
  sessionId,
  version,
  config,
  cwd,
  width,
  refreshKey,
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cost,
  totalTokens,
  tokensWarning,
  goalLabel,
  autoCompactRemainingPct,
}: StatuslineProps): React.JSX.Element {
  const [commandText, setCommandText] = useState<string | null>(null);
  const input = useMemo(
    () =>
      buildStatuslineInput({
        state,
        sessionId,
        version,
        cwd,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        costUsd: cost,
      }),
    [
      cost,
      cwd,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      sessionId,
      state,
      version,
    ],
  );
  const nativeText = renderNativeStatusline(input);
  const paddingX = config?.padding ?? 2;
  const command = config?.type === "command" ? config.command : null;
  const fastToken = fastModeStatuslineSuffix(state);

  useEffect(() => {
    void refreshKey;
    if (!command) {
      setCommandText(null);
      return;
    }
    let cancelled = false;
    runStatuslineCommand(command, input).then((text) => {
      if (!cancelled) setCommandText(text);
    });
    return () => {
      cancelled = true;
    };
  }, [command, input, refreshKey]);

  const warningColor = tokensWarning?.severity === "error" ? Color.error : Color.warning;
  const rightText = rightStatusText(tokensWarning, totalTokens);
  const rightColor = tokensWarning ? warningColor : Color.muted;
  const primaryRow: StatusSegment[] = [];
  if (autoCompactRemainingPct !== undefined) {
    primaryRow.push({
      key: "compact",
      text: `${autoCompactRemainingPct}% until auto-compact`,
      color: Color.warning,
    });
  }
  if (rightText !== null) {
    primaryRow.push({ key: "tokens", text: rightText, color: rightColor });
  }
  if (goalLabel) {
    primaryRow.push({ key: "goal", text: goalLabel, color: Color.primaryGlow });
  }
  return (
    <Box paddingX={paddingX} width={width} justifyContent="space-between">
      <Box flexShrink={1}>
        {commandText === null ? (
          <HighlightedStatusline text={nativeText} fastToken={fastToken} />
        ) : (
          <Text color={Color.muted} wrap="truncate">
            {commandText}
          </Text>
        )}
      </Box>
      {primaryRow.length > 0 && (
        <Box marginLeft={2} flexShrink={0}>
          <StatusChain segments={primaryRow} />
        </Box>
      )}
    </Box>
  );
}

interface HighlightedStatuslineProps {
  text: string;
  fastToken: string | null;
}

function HighlightedStatusline({ text, fastToken }: HighlightedStatuslineProps): React.JSX.Element {
  const ranges: { start: number; end: number; color: InkColor; bold?: boolean }[] = [];
  if (fastToken !== null) {
    const start = text.lastIndexOf(fastToken);
    if (start >= 0) {
      ranges.push({ start, end: start + fastToken.length, color: Color.fastMode, bold: true });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const parts: React.JSX.Element[] = [];
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push(
        <Text key={`plain-${cursor}`} color={Color.muted}>
          {text.slice(cursor, range.start)}
        </Text>,
      );
    }
    parts.push(
      <Text key={`hi-${range.start}`} color={range.color} bold={range.bold === true}>
        {text.slice(range.start, range.end)}
      </Text>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push(
      <Text key={`plain-${cursor}`} color={Color.muted}>
        {text.slice(cursor)}
      </Text>,
    );
  }
  return <Text wrap="truncate">{parts.length > 0 ? parts : text}</Text>;
}

const sameWarning = (
  a: StatuslineProps["tokensWarning"],
  b: StatuslineProps["tokensWarning"],
): boolean => a?.message === b?.message && a?.severity === b?.severity;

export const statuslinePropsEqual = (prev: StatuslineProps, next: StatuslineProps): boolean =>
  prev.state === next.state &&
  prev.sessionId === next.sessionId &&
  prev.version === next.version &&
  prev.config === next.config &&
  prev.cwd === next.cwd &&
  prev.width === next.width &&
  prev.refreshKey === next.refreshKey &&
  prev.inputTokens === next.inputTokens &&
  prev.outputTokens === next.outputTokens &&
  prev.cacheCreationInputTokens === next.cacheCreationInputTokens &&
  prev.cacheReadInputTokens === next.cacheReadInputTokens &&
  prev.cost === next.cost &&
  prev.totalTokens === next.totalTokens &&
  prev.goalLabel === next.goalLabel &&
  prev.autoCompactRemainingPct === next.autoCompactRemainingPct &&
  sameWarning(prev.tokensWarning, next.tokensWarning);

const StatuslineInner = memo(StatuslineImpl, statuslinePropsEqual);

export function Statusline(props: Omit<StatuslineProps, "width">): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  return <StatuslineInner {...props} width={columns} />;
}
