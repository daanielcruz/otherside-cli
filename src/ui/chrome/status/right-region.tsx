import { memo, useContext, useEffect, useMemo, useRef } from "react";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { useAppSelect } from "@/store/app-store/index.ts";
import {
  expireCurrentNotice,
  RightNoticeKey,
  setRegionPaused,
  tickRegionRefresh,
} from "@/store/app-store/right-region-notices.ts";
import {
  type NoticeTone,
  type RightRegionSegment,
  selectNextDeadlineAt,
  selectRightRegionView,
} from "@/store/app-store/slices/right-region.ts";
import {
  Box,
  type Color as InkColor,
  Text,
  TimekeeperContext,
  useFrameClock,
  useVisibleRegion,
} from "@/terminal-runtime";
import { Color } from "@/ui/theme/theme.ts";

const VOICE_PROCESSING_DIM = 153;
const VOICE_PROCESSING_BRIGHT = 185;
const VOICE_PULSE_PERIOD_S = 2;
const SEPARATOR = " · ";
const SEPARATOR_WIDTH = stringWidth(SEPARATOR);

function toneColor(tone: NoticeTone): InkColor {
  if (tone === "error") return Color.error;
  if (tone === "warning") return Color.warning;
  if (tone === "success") return Color.success;
  if (tone === "primary") return Color.primaryGlow;
  if (tone === "design") return Color.designSession;
  return Color.muted;
}

function truncateToWidth(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (stringWidth(text) <= budget) return text;
  if (budget <= 1) return "…";
  let end = text.length;
  while (end > 0 && stringWidth(text.slice(0, end)) + 1 > budget) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

function budgetSegments(
  segments: readonly RightRegionSegment[],
  maxWidth: number,
): RightRegionSegment[] {
  if (segments.length === 0 || maxWidth <= 0) return [];
  const result: RightRegionSegment[] = [];
  let remaining = maxWidth;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const separatorCost = index === 0 ? 0 : SEPARATOR_WIDTH;
    if (remaining <= separatorCost) break;
    const textBudget = remaining - separatorCost;
    const text = truncateToWidth(segment.text, textBudget);
    if (text.length === 0) break;
    result.push({ ...segment, text });
    remaining -= separatorCost + stringWidth(text);
  }
  return result;
}

function VoiceProcessingLabel(): React.JSX.Element {
  const [ref, time] = useFrameClock(50);
  const opacity = (Math.sin(((time / 1000) * Math.PI * 2) / VOICE_PULSE_PERIOD_S) + 1) / 2;
  const channel = Math.round(
    VOICE_PROCESSING_DIM + (VOICE_PROCESSING_BRIGHT - VOICE_PROCESSING_DIM) * opacity,
  );
  const hex: `#${string}` = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
  return (
    <Box ref={ref}>
      <Text color={hex}>Voice: processing…</Text>
    </Box>
  );
}

interface SegmentChainProps {
  segments: readonly RightRegionSegment[];
}

function SegmentChain({ segments }: SegmentChainProps): React.JSX.Element {
  return (
    <Text>
      {segments.map((segment, index) => (
        <Text key={segment.key}>
          {index > 0 && <Text color={Color.muted}>{SEPARATOR}</Text>}
          <SegmentLabel segment={segment} />
        </Text>
      ))}
    </Text>
  );
}

function SegmentLabel({ segment }: { segment: RightRegionSegment }): React.JSX.Element {
  if (segment.key === RightNoticeKey.voiceProcessing) {
    return <VoiceProcessingLabel />;
  }
  const color = toneColor(segment.tone);
  if (segment.bold) {
    return (
      <Text color={color} bold>
        {segment.text}
      </Text>
    );
  }
  if (segment.dim) {
    return (
      <Text color={color} dim>
        {segment.text}
      </Text>
    );
  }
  return <Text color={color}>{segment.text}</Text>;
}

export interface RightStatusRegionProps {
  /** Available columns for the right cluster (after left content + gap). */
  maxWidth: number;
}

function RightStatusRegionImpl({ maxWidth }: RightStatusRegionProps): React.JSX.Element | null {
  const region = useAppSelect((s) => s.rightRegion);
  const clock = useContext(TimekeeperContext);
  const [visibleRef, visibility] = useVisibleRegion();
  const wasVisibleRef = useRef(true);

  const now = Date.now();
  const view = useMemo(() => selectRightRegionView(region, now), [region, now]);
  const deadlineAt = selectNextDeadlineAt(region, now);
  const segments = useMemo(
    () => budgetSegments(view.segments, maxWidth),
    [view.segments, maxWidth],
  );

  // Off-viewport pauses remaining ephemeral time (reference: animation pauses off-viewport).
  useEffect(() => {
    const visible = visibility.isVisible;
    if (visible === wasVisibleRef.current) return;
    wasVisibleRef.current = visible;
    setRegionPaused(!visible);
  }, [visibility.isVisible]);

  // Single shared Timekeeper deadline for expiry + persistent refresh.
  useEffect(() => {
    if (!clock || deadlineAt === null || region.paused) return;
    const delay = Math.max(0, deadlineAt - Date.now());
    return clock.setTimeout(() => {
      const t = Date.now();
      expireCurrentNotice(t);
      tickRegionRefresh(t);
    }, delay);
  }, [
    clock,
    deadlineAt,
    region.paused,
    region.ephemeralCurrent?.key,
    region.ephemeralCurrent?.expiresAt,
    region.refreshGeneration,
    region.persistents,
  ]);

  if (segments.length === 0) return null;

  return (
    <Box ref={visibleRef} flexShrink={0}>
      <SegmentChain segments={segments} />
    </Box>
  );
}

export const RightStatusRegion = memo(RightStatusRegionImpl);
