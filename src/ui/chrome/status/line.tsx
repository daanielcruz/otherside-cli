import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Color as InkColor } from "@/ink";
import { Box, Text, useTerminalDimensions } from "@/ink";
import type { StatuslineConfig } from "@/kernel/config/config.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { submitOrchestrationNotice } from "@/store/app-store/right-region-notices.ts";
import {
  buildStatuslineInput,
  fastModeStatuslineSuffix,
  orchestrationNoticeText,
  renderNativeStatusline,
  runStatuslineCommand,
} from "@/ui/chrome/status/line-input.ts";
import { RightStatusRegion } from "@/ui/chrome/status/right-region.tsx";
import { Color } from "@/ui/theme/theme.ts";

export interface StatuslineProps {
  state: BrokerState;
  sessionId: string;
  version: string;
  config?: StatuslineConfig | undefined;
  orchestrationMode?: OrchestrationMode | undefined;
  cwd: string;
  width: number;
  refreshKey: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  cost?: number | undefined;
  totalTokens?: number | undefined;
}

// Publishes multiprovider start/switch notices into the shared right-region queue.
function useOrchestrationNoticePublisher(mode: OrchestrationMode): void {
  const previousMode = useRef<OrchestrationMode | null>(null);
  useEffect(() => {
    const kind = previousMode.current === null ? "startup" : "switch";
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    const text = orchestrationNoticeText(mode, kind);
    if (text === null) return;
    submitOrchestrationNotice(text);
  }, [mode]);
}

function StatuslineImpl({
  state,
  sessionId,
  version,
  config,
  orchestrationMode,
  cwd,
  width,
  refreshKey,
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  cost,
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
  useOrchestrationNoticePublisher(orchestrationMode ?? "disabled");
  const nativeText = renderNativeStatusline(input);
  const paddingX = config?.padding ?? 2;
  const command = config?.type === "command" ? config.command : null;
  const fastToken = fastModeStatuslineSuffix(state);
  // Rough budget: full width minus padding, left content reserve, and gap.
  const rightMaxWidth = Math.max(12, Math.floor(width * 0.45));

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
      <Box marginLeft={2} flexShrink={0}>
        <RightStatusRegion maxWidth={rightMaxWidth} />
      </Box>
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

export const statuslinePropsEqual = (prev: StatuslineProps, next: StatuslineProps): boolean =>
  prev.state === next.state &&
  prev.sessionId === next.sessionId &&
  prev.version === next.version &&
  prev.config === next.config &&
  prev.orchestrationMode === next.orchestrationMode &&
  prev.cwd === next.cwd &&
  prev.width === next.width &&
  prev.refreshKey === next.refreshKey &&
  prev.inputTokens === next.inputTokens &&
  prev.outputTokens === next.outputTokens &&
  prev.cacheCreationInputTokens === next.cacheCreationInputTokens &&
  prev.cacheReadInputTokens === next.cacheReadInputTokens &&
  prev.cost === next.cost &&
  prev.totalTokens === next.totalTokens;

const StatuslineInner = memo(StatuslineImpl, statuslinePropsEqual);

export function Statusline(props: Omit<StatuslineProps, "width">): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  return <StatuslineInner {...props} width={columns} />;
}
