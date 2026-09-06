import { setEffortFeedback } from "@/commands/handlers/effort.ts";
import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { effortLevelsForModel } from "@/engine/model/catalog.ts";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { applyBrokerEvent } from "@/store/subscribers/broker.ts";
import { recordPanelCommitRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import { type FooterPanelSpec, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { effortColor } from "@/ui/theme/effort-color.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const TRACK_WIDTH_DEFAULT = 42;
const ULTRACODE_LABEL = "ultracode";
const DEFAULT_LABEL = "default";
const LABEL_MIN_GAP = 1;

type SliderLevel = EffortLevel | typeof ULTRACODE_LABEL | typeof DEFAULT_LABEL;
type SliderLayout = { positions: number[]; trackWidth: number };

/**
 * Effort selector on the string model — a Speed↔Intelligence slider whose marker
 * moves with ←/→ (and ↑/↓). Enter applies: a real level updates the session broker
 * state and persists `effortLevel`; `ultracode` opens its sub-overlay when the model
 * has effort levels, else flips the session flag. Escape closes.
 */
class EffortPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private readonly levels: SliderLevel[];
  private readonly layout: SliderLayout;
  private idx: number;

  constructor(private readonly close: () => void) {
    const state = readStringViewBrokerState();
    const ultracodeAvailable = isWorkflowEnabled(loadConfigSync());
    this.levels = buildLevels(state.model, state.provider, ultracodeAvailable);
    this.idx = resolveInitialIdx(this.levels, state.effort, state.ultracode === true);
    this.layout = sliderLayout(this.levels);
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const body: string[] = [];
    if (this.levels.length === 0) {
      body.push(
        renderTextWithStyles("no effort controls for this provider", { color: Color.muted }),
      );
    } else {
      if (!isTwoPositionSelector(this.levels)) {
        body.push(
          ` ${renderTextWithStyles(header(this.layout.trackWidth), { color: Color.muted })}`,
        );
      }
      body.push(` ${renderTextWithStyles(track(this.idx, this.layout), { color: Color.text })}`);
      body.push(` ${labelLine(this.levels, this.layout, this.idx)}`);
    }

    const spec: FooterPanelSpec = {
      command: "/effort",
      title: "Effort",
      footerHints: [
        ["←/→", "to change effort"],
        ["Enter", "to confirm"],
        ["Esc", "to close"],
      ],
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    switch (key.name) {
      case "up":
      case "left":
        this.move(-1);
        return;
      case "down":
      case "right":
        this.move(1);
        return;
      case "return":
        this.activate();
        return;
      case "escape":
        this.close();
        return;
    }
  }

  private move(delta: number): void {
    this.idx = Math.max(0, Math.min(this.levels.length - 1, this.idx + delta));
    this.ctx?.requestRender();
  }

  private activate(): void {
    const level = this.levels[this.idx];
    if (level === undefined) return;
    const state = readStringViewBrokerState();

    if (level === ULTRACODE_LABEL) {
      if (effortLevelsForModel({ provider: state.provider, model: state.model }).length > 0) {
        this.close();
        overlayStack.open("ultracode-effort");
        return;
      }
      applyBrokerEvent({ kind: "set_ultracode", enabled: true }, { ultracode: true });
      if (state.ultracode !== true) recordPanelCommitRef.current("effort", "ultracode");
      this.close();
      return;
    }

    if (level === DEFAULT_LABEL) {
      applyBrokerEvent({ kind: "set_ultracode", enabled: false }, { ultracode: false });
      if (state.ultracode === true) recordPanelCommitRef.current("effort", "ultracode off");
      this.close();
      return;
    }

    applyBrokerEvent({ kind: "set_effort", effort: level }, { effort: level, ultracode: false });
    void updateConfig((config) => {
      config.effortLevel = level;
    });
    if (state.effort !== level || state.ultracode === true) {
      recordPanelCommitRef.current("effort", setEffortFeedback(level));
    }
    this.close();
  }
}

function buildLevels(
  model: string,
  provider: ProviderId,
  ultracodeAvailable: boolean,
): SliderLevel[] {
  const levels = effortLevelsForModel({ provider, model });
  if (levels.length === 0) {
    return ultracodeAvailable ? [DEFAULT_LABEL, ULTRACODE_LABEL] : [];
  }
  return ultracodeAvailable ? [...levels, ULTRACODE_LABEL] : levels;
}

function resolveInitialIdx(
  levels: SliderLevel[],
  effort: EffortLevel | null,
  ultracodeActive: boolean,
): number {
  if (ultracodeActive) {
    const ultracodeIdx = levels.indexOf(ULTRACODE_LABEL);
    if (ultracodeIdx >= 0) return ultracodeIdx;
  }
  const effortIdx = effort !== null ? levels.indexOf(effort) : -1;
  return Math.max(0, effortIdx);
}

function isTwoPositionSelector(levels: SliderLevel[]): boolean {
  return levels.length === 2 && levels[0] === DEFAULT_LABEL && levels[1] === ULTRACODE_LABEL;
}

function header(trackWidth: number): string {
  const gap = Math.max(1, trackWidth - "Speed".length - "Intelligence".length);
  return `Speed${" ".repeat(gap)}Intelligence`;
}

function track(idx: number, layout: SliderLayout): string {
  const marker = layout.positions[Math.max(0, Math.min(idx, layout.positions.length - 1))] ?? 0;
  return Array.from({ length: layout.trackWidth }, (_, index) =>
    index === marker ? "▲" : Glyph.boxHLine,
  ).join("");
}

function labelLine(levels: SliderLevel[], layout: SliderLayout, idx: number): string {
  let cursor = 0;
  let line = "";
  levels.forEach((level, index) => {
    const position = layout.positions[index] ?? 0;
    const idealStart = Math.max(
      0,
      Math.min(layout.trackWidth - level.length, position - Math.floor(level.length / 2)),
    );
    // Never let labels collide — pack forward with a minimum gap if the ideal
    // center would overlap the previous label (dense scales like ultra+ultracode).
    const start = index === 0 ? idealStart : Math.max(idealStart, cursor + LABEL_MIN_GAP);
    line += " ".repeat(Math.max(0, start - cursor));
    line += renderTextWithStyles(level, {
      color: index === idx ? effortColor(level) : Color.muted,
      bold: index === idx,
    });
    cursor = start + level.length;
  });
  return line;
}

function sliderLayout(levels: SliderLevel[]): SliderLayout {
  if (levels.length === 0) return { positions: [], trackWidth: TRACK_WIDTH_DEFAULT };
  if (levels.length === 1) {
    const width = Math.max(TRACK_WIDTH_DEFAULT, levels[0]?.length ?? 0);
    return { positions: [Math.floor(width / 2)], trackWidth: width };
  }

  // Pack labels left-to-right with a minimum gap so they never collide, then
  // expand to at least TRACK_WIDTH_DEFAULT by distributing leftover space evenly
  // into the gaps (keeps the Speed↔Intelligence track readable).
  const widths = levels.map((level) => level.length);
  const minContent = widths.reduce((sum, w) => sum + w, 0) + LABEL_MIN_GAP * (levels.length - 1);
  const trackWidth = Math.max(TRACK_WIDTH_DEFAULT, minContent);
  const gapCount = levels.length - 1;
  const baseExtra = Math.floor((trackWidth - minContent) / gapCount);
  let remainder = (trackWidth - minContent) % gapCount;

  const starts: number[] = [];
  let cursor = 0;
  for (let index = 0; index < levels.length; index++) {
    starts.push(cursor);
    const width = widths[index] ?? 0;
    if (index < gapCount) {
      const gap = LABEL_MIN_GAP + baseExtra + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      cursor += width + gap;
    } else {
      cursor += width;
    }
  }
  const positions = starts.map((start, index) => start + Math.floor((widths[index] ?? 0) / 2));
  return { positions, trackWidth };
}

export function createEffortPanel(close: () => void): StringViewPanel {
  return new EffortPanel(close);
}
