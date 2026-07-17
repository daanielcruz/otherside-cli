import { Fragment, useState } from "react";
import { setEffortFeedback } from "@/commands/index.ts";
import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { effortLevelsForModel } from "@/engine/model/catalog.ts";
import { Box, Text } from "@/ink";
import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { Broker, BrokerEvent } from "@/store/app-store/broker.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayDispatch, useOverlayState } from "@/ui/panels/context";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { effortColor } from "@/ui/theme/effort-color.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const TRACK_WIDTH_DEFAULT = 42;
const ULTRACODE_LABEL = "ultracode";
const DEFAULT_LABEL = "default";
const LABEL_MIN_GAP = 1;

export interface EffortOverlayProps {
  broker?: Broker;
  config?: UserConfig | undefined;
  onClose?: () => void;
  isTurnRunning?: (() => boolean) | undefined;
}

export function EffortOverlay({
  broker,
  config,
  onClose,
  isTurnRunning,
}: EffortOverlayProps = {}): React.JSX.Element {
  const overlayState = useOverlayState();
  const dispatch = useOverlayDispatch();
  const activeBroker = broker ?? overlayState.broker;
  const close = useOverlayClose(onClose);
  const state = activeBroker.read();
  const ultracodeAvailable = !!config && isWorkflowEnabled(config);
  const levels = buildLevels(state.model, state.provider, ultracodeAvailable);
  const initialIdx = resolveInitialIdx(levels, state.effort, state.ultracode === true);
  const [idx, setIdx] = useState(initialIdx);
  const layout = sliderLayout(levels);

  const activate = (): void => {
    const lvl = levels[idx];
    if (!lvl) return;
    if (lvl === ULTRACODE_LABEL) {
      if (effortLevelsForModel(state.model, state.provider).length > 0) {
        close();
        dispatch.openOverlay("ultracode-effort");
        return;
      }
      // Slip-direct: broker state is re-read on the next request.
      activeBroker.dispatch({ kind: "set_ultracode", enabled: true });
      dispatch.recordPanelCommit?.("effort", "ultracode");
      close();
      return;
    }
    if (lvl === DEFAULT_LABEL) {
      const disableEvent: BrokerEvent = { kind: "set_ultracode", enabled: false };
      activeBroker.dispatch(disableEvent);
      dispatch.recordPanelCommit?.("effort", "Set effort default (ultracode off)");
    } else {
      activeBroker.dispatch({ kind: "set_effort", effort: lvl });
      void updateConfig((current) => {
        current.effortLevel = lvl;
      });
      dispatch.recordPanelCommit?.("effort", setEffortFeedback(lvl));
    }
    close();
  };

  usePanelNavigation({
    onClose: close,
    onActivate: activate,
    rows: { count: levels.length, selected: idx, onChange: setIdx },
    onKey: (_input, key) => {
      if (key.leftArrow) {
        setIdx((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.rightArrow) {
        setIdx((i) => Math.min(levels.length - 1, i + 1));
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command="/effort"
      title="Effort"
      onCancel={close}
      footerHints={[
        ["←/→", "to change effort"],
        ["Enter", "to confirm"],
        ["Esc", "to close"],
      ]}
    >
      {levels.length === 0 ? (
        <Text color={Color.muted}>no effort controls for this provider</Text>
      ) : (
        <>
          {!isTwoPositionSelector(levels) && (
            <Text color={Color.muted}> {header(layout.trackWidth)}</Text>
          )}
          <Text color={Color.text}> {track(idx, layout)}</Text>
          <Box>
            <Text> </Text>
            {labelParts(levels, layout, idx)}
          </Box>
        </>
      )}
    </FooterPanel>
  );
}

function buildLevels(
  model: string,
  provider: string,
  ultracodeAvailable: boolean,
): (EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL)[] {
  const levels = effortLevelsForModel(
    model,
    provider as Parameters<typeof effortLevelsForModel>[1],
  );
  if (levels.length === 0) {
    if (!ultracodeAvailable) return [];
    return [DEFAULT_LABEL, ULTRACODE_LABEL];
  }
  if (!ultracodeAvailable) return levels;
  return [...levels, ULTRACODE_LABEL];
}

function resolveInitialIdx(
  levels: (EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL)[],
  effort: EffortLevel | null,
  ultracodeActive: boolean,
): number {
  if (ultracodeActive) {
    const ucIdx = levels.indexOf(ULTRACODE_LABEL);
    if (ucIdx >= 0) return ucIdx;
  }
  const effortIdx = effort !== null ? levels.indexOf(effort) : -1;
  return Math.max(0, effortIdx);
}

function header(trackWidth: number): string {
  return `Speed${" ".repeat(Math.max(1, trackWidth - "Speed".length - "Intelligence".length))}Intelligence`;
}

function labelParts(
  levels: (EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL)[],
  layout: SliderLayout,
  idx: number,
): React.JSX.Element[] {
  let cursor = 0;
  return levels.map((lvl, i) => {
    const position = layout.positions[i] ?? 0;
    const idealStart = Math.max(
      0,
      Math.min(layout.trackWidth - lvl.length, position - Math.floor(lvl.length / 2)),
    );
    // Never let labels collide — pack forward with a minimum gap if the ideal
    // center would overlap the previous label (dense scales like ultra+ultracode).
    const start = i === 0 ? idealStart : Math.max(idealStart, cursor + LABEL_MIN_GAP);
    const gap = Math.max(0, start - cursor);
    cursor = start + lvl.length;
    return (
      <Fragment key={lvl}>
        {gap > 0 && <Text>{" ".repeat(gap)}</Text>}
        <Text color={i === idx ? effortColor(lvl) : Color.muted} bold={i === idx}>
          {lvl}
        </Text>
      </Fragment>
    );
  });
}

function track(idx: number, layout: SliderLayout): string {
  const marker = layout.positions[Math.max(0, Math.min(idx, layout.positions.length - 1))] ?? 0;
  return Array.from({ length: layout.trackWidth }, (_, i) =>
    i === marker ? "▲" : Glyph.boxHLine,
  ).join("");
}

type SliderLayout = { positions: number[]; trackWidth: number };

function isTwoPositionSelector(
  levels: (EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL)[],
): boolean {
  return levels.length === 2 && levels[0] === DEFAULT_LABEL && levels[1] === ULTRACODE_LABEL;
}

function sliderLayout(
  levels: (EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL)[],
): SliderLayout {
  if (levels.length === 0) return { positions: [], trackWidth: TRACK_WIDTH_DEFAULT };
  if (levels.length === 1) {
    const width = Math.max(TRACK_WIDTH_DEFAULT, levels[0]?.length ?? 0);
    return { positions: [Math.floor(width / 2)], trackWidth: width };
  }

  // Pack labels left-to-right with a minimum gap so they never collide, then
  // expand to at least TRACK_WIDTH_DEFAULT by distributing leftover space
  // evenly into the gaps (keeps the Speed↔Intelligence track readable).
  const widths = levels.map((lvl) => lvl.length);
  const minContent = widths.reduce((sum, w) => sum + w, 0) + LABEL_MIN_GAP * (levels.length - 1);
  const trackWidth = Math.max(TRACK_WIDTH_DEFAULT, minContent);
  const extra = trackWidth - minContent;
  const gapCount = levels.length - 1;
  const baseExtra = Math.floor(extra / gapCount);
  let remainder = extra % gapCount;

  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < levels.length; i++) {
    starts.push(cursor);
    const width = widths[i] ?? 0;
    if (i < gapCount) {
      const gap = LABEL_MIN_GAP + baseExtra + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      cursor += width + gap;
    } else {
      cursor += width;
    }
  }
  const positions = starts.map((start, i) => start + Math.floor((widths[i] ?? 0) / 2));
  return { positions, trackWidth };
}
