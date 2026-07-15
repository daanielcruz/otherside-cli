import { type ReactNode, useEffect, useRef } from "react";
import { Box, Text, useFrameClock } from "@/ink";
import { readLiveOutputTokens } from "@/store/live-tokens/index.ts";
import {
  formatElapsed,
  SHIMMER_TICK_MS,
  type SpinnerMode,
  shimmerSegments,
  spinnerFrame,
  tipAt,
} from "@/ui/chrome/progress/index.ts";
import { Color, Glyph, GUTTER_HEAD } from "@/ui/theme/theme.ts";

const TICK_MS = 50;

import { RATE_LIMIT_PATTERN, type RetryStatusLine } from "../stream/retry.ts";

export type { RetryStatusLine, SpinnerMode };

export interface ThinkingBlockProps {
  active: boolean;
  startedAt: number | null;
  tipIndex: number;
  verb: string;
  tokenCount?: number;
  includeGlobalTokenCount?: boolean;
  spinnerMode?: SpinnerMode;
  thinkingStatus?: "thinking" | number | null;
  thinkingSuffix?: string;
  showTip?: boolean;
  taskList?: ReactNode;
  nextPendingSubject?: string;
  nextHint?: string;
  retryStatus?: RetryStatusLine | null;
  progressBar?: boolean;
}

const PROGRESS_BAR_WIDTH = 40;
const COMPACT_EASE_SECONDS = 90;
const COMPACT_MAX_RATIO = 0.95;

interface AnimatedHeaderProps {
  active: boolean;
  startedAt: number;
  verb: string;
  tokenCount: number;
  includeGlobalTokenCount: boolean;
  spinnerMode: SpinnerMode;
  thinkingStatus: "thinking" | number | null;
  thinkingSuffix: string;
  progressBar: boolean;
  time: number;
}

function AnimatedHeaderLine({
  active,
  startedAt,
  verb,
  tokenCount,
  includeGlobalTokenCount,
  spinnerMode,
  thinkingStatus,
  thinkingSuffix,
  progressBar,
  time,
}: AnimatedHeaderProps): React.JSX.Element {
  const displayedCountRef = useRef(0);

  useEffect(() => {
    if (!active) {
      displayedCountRef.current = 0;
    }
  }, [active]);

  const liveResponseLength = includeGlobalTokenCount
    ? Math.max(tokenCount, readLiveOutputTokens())
    : tokenCount;

  const frame = spinnerFrame(time);
  const elapsedMs = Date.now() - startedAt;
  const elapsed = formatElapsed(elapsedMs);
  const { before, shimmer, after } = shimmerSegments(verb, time);

  displayedCountRef.current = syncCounter(displayedCountRef.current, liveResponseLength);
  const count = displayedCountRef.current;
  const showTokens = count > 0 && !progressBar;
  const modeGlyph = spinnerMode === "requesting" ? Glyph.arrowUp : Glyph.arrowDown;
  const thinkingText = progressBar ? "" : formatThinkingStatus(thinkingStatus, thinkingSuffix);
  const thinkingPart = thinkingText ? ` · ${thinkingText}` : "";

  return (
    <Box>
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={Color.primary} bold>
          {frame}
        </Text>
      </Box>
      {before.length > 0 && <Text color={Color.primary}>{before}</Text>}
      {shimmer.length > 0 && (
        <Text color={Color.primaryGlow} bold>
          {shimmer}
        </Text>
      )}
      {after.length > 0 && <Text color={Color.primary}>{after}</Text>}
      <Text color={Color.primary}>… </Text>
      <Text color={Color.muted}>({elapsed}</Text>
      {showTokens && (
        <>
          <Text color={Color.muted}>{" · "}</Text>
          <Box width={2}>
            <Text color={Color.muted}>{modeGlyph}</Text>
          </Box>
          <Text color={Color.muted}>{`${formatTokenCount(count)} tokens`}</Text>
        </>
      )}
      {thinkingPart.length > 0 && <Text color={Color.muted}>{thinkingPart}</Text>}
      <Text color={Color.muted}>)</Text>
    </Box>
  );
}

function AnimatedRetryLine({ retryStatus }: { retryStatus: RetryStatusLine }): React.JSX.Element {
  const [ref, time] = useFrameClock(TICK_MS);
  const headline = formatRetryHeadline(retryStatus);
  const initialSeconds = Math.max(1, Math.round(retryStatus.delayMs / 1000));
  const elapsedSec = Math.max(0, Math.floor((Date.now() - retryStatus.startedAt) / 1000));
  const remainingSec = Math.max(0, initialSeconds - elapsedSec);
  const blinkOn = Math.floor(time / 500) % 2 === 0;
  const prefix = remainingSec > 0 ? `Retrying in ${remainingSec}s` : "Retrying";
  const suffix = ` · attempt ${retryStatus.attempt}/${retryStatus.maxAttempts}`;

  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      <Box>
        <Text color={Color.error} bold>
          {`${Glyph.bullet} `}
        </Text>
        <Text color={Color.error} bold>
          {headline}
        </Text>
      </Box>
      <Box>
        <Text color={Color.muted}>{GUTTER_HEAD}</Text>
        <Text color={Color.muted} dim={remainingSec === 0 && !blinkOn}>
          {prefix}
        </Text>
        <Text color={Color.muted}>{suffix}</Text>
      </Box>
      <Box height={1} />
    </Box>
  );
}

export function ThinkingBlock(props: ThinkingBlockProps): React.JSX.Element | null {
  const { active, startedAt, retryStatus = null } = props;
  if (!active || startedAt === null) {
    return <Box height={1} />;
  }
  if (retryStatus) {
    return <AnimatedRetryLine retryStatus={retryStatus} />;
  }
  return <AnimatedThinkingBody {...props} startedAt={startedAt} />;
}

function AnimatedThinkingBody({
  active,
  startedAt,
  tipIndex,
  verb,
  tokenCount = 0,
  includeGlobalTokenCount = true,
  spinnerMode = "requesting",
  thinkingStatus = null,
  thinkingSuffix = "",
  showTip = true,
  taskList,
  nextPendingSubject,
  nextHint,
  progressBar = false,
}: Omit<ThinkingBlockProps, "retryStatus"> & { startedAt: number }): React.JSX.Element {
  const [ref, time] = useFrameClock(active ? SHIMMER_TICK_MS : null);
  const tip = tipAt(tipIndex);

  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      <AnimatedHeaderLine
        active={active}
        startedAt={startedAt}
        verb={verb}
        tokenCount={tokenCount}
        includeGlobalTokenCount={includeGlobalTokenCount}
        spinnerMode={spinnerMode}
        thinkingStatus={thinkingStatus}
        thinkingSuffix={thinkingSuffix}
        progressBar={progressBar}
        time={time}
      />
      {progressBar && <CompactProgressBar startedAt={startedAt} active={active} />}
      {renderGutter({ taskList, nextPendingSubject, nextHint, showTip, tip })}
      <Box height={1} />
    </Box>
  );
}

function renderGutter(input: {
  taskList: ReactNode;
  nextPendingSubject: string | undefined;
  nextHint: string | undefined;
  showTip: boolean;
  tip: string;
}): ReactNode {
  const { taskList, nextPendingSubject, nextHint, showTip, tip } = input;
  if (taskList) return taskList;
  if (nextPendingSubject) {
    return (
      <Box>
        <Text color={Color.muted}>{`${GUTTER_HEAD}Next: ${nextPendingSubject}`}</Text>
        {!!nextHint && <Text color={Color.muted} dim>{`  ${nextHint}`}</Text>}
      </Box>
    );
  }
  if (showTip) {
    return (
      <Box>
        <Text color={Color.muted}>{`${GUTTER_HEAD}Tip: ${tip}`}</Text>
      </Box>
    );
  }
  return <Box height={1} />;
}

function CompactProgressBar({
  startedAt,
  active,
}: {
  startedAt: number;
  active: boolean;
}): React.JSX.Element {
  const displayedRatioRef = useRef(0);

  useEffect(() => {
    displayedRatioRef.current = 0;
  }, [startedAt]);

  useEffect(() => {
    if (!active) displayedRatioRef.current = 0;
  }, [active]);

  const rawRatio = compactProgressRatio(Date.now() - startedAt);
  displayedRatioRef.current = monotonicRatio(displayedRatioRef.current, rawRatio);
  const ratio = active ? displayedRatioRef.current : rawRatio;
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;
  return (
    <Box>
      <Text color={Color.muted}>{"  "}</Text>
      <Text color={Color.text}>{Glyph.barFilled.repeat(filled)}</Text>
      <Text color={Color.text} dim>
        {Glyph.barEmpty.repeat(empty)}
      </Text>
      <Text color={Color.muted}>{` ${Math.round(ratio * 100)}%`}</Text>
    </Box>
  );
}

export function compactProgressRatio(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return Math.min(COMPACT_MAX_RATIO, 1 - Math.exp(-seconds / COMPACT_EASE_SECONDS));
}

export function monotonicRatio(previous: number, candidate: number): number {
  return Math.max(previous, candidate);
}

function retryMessageBody(status: RetryStatusLine): string {
  if (status.message && status.message.trim().length > 0) return status.message.trim();
  if (RATE_LIMIT_PATTERN.test(status.reason)) return "Rate limited";
  return status.reason.replace(/^HTTP \d+[^:]*:\s*/, "").slice(0, 200);
}

function formatRetryHeadline(status: RetryStatusLine): string {
  const code = status.status;
  const msg = retryMessageBody(status).replace(/\s+/g, " ");
  if (typeof code === "number") return `HTTP ${code}: ${msg}`;
  return msg;
}

function formatThinkingStatus(status: "thinking" | number | null, suffix: string): string {
  if (status === "thinking") return `reasoning${suffix}`;
  if (typeof status === "number") return `reasoned for ${Math.max(1, Math.round(status / 1000))}s`;
  return "";
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function stepCounter(current: number, target: number): number {
  if (target <= current) return target;
  const gap = target - current;
  let increment: number;
  if (gap < 70) increment = 3;
  else if (gap < 200) increment = Math.max(8, Math.ceil(gap * 0.15));
  else increment = 50;
  return Math.min(current + increment, target);
}

function syncCounter(current: number, target: number): number {
  if (current === 0 && target > 0) return target;
  return stepCounter(current, target);
}
