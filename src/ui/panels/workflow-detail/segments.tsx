import type React from "react";
import type { MergedPhase } from "@/engine/background/workflows/runtime/progress/merge.ts";
import type { WorkflowAgentProgress } from "@/engine/background/workflows/runtime/store/types.ts";
import { type Color as InkColor, Text } from "@/ink";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import {
  type AgentDisplayStatus,
  agentStatusGlyph,
  CROSS,
  TICK,
} from "@/ui/chrome/progress/glyphs.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const TRAILER_SEPARATOR = " · ";
const AGENT_ROW_TRAILER_INSET = 4;
const AGENT_LABEL_INSET = 4;
const PANE_RULE_LABEL_INSET = 2;

export interface Segment {
  text: string;
  color?: InkColor | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
}

export function seg(input: {
  text: string;
  color?: InkColor;
  bold?: boolean;
  dim?: boolean;
}): Segment {
  const { text, color, bold, dim } = input;
  return {
    text,
    ...(color ? { color } : {}),
    ...(bold ? { bold } : {}),
    ...(dim ? { dim } : {}),
  };
}

export function truncateToWidth(input: { text: string; max: number }): string {
  const { text, max } = input;
  if (max <= 0) return "";
  if (stringWidth(text) <= max) return text;
  let used = 0;
  let out = "";
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (used + charWidth > max) break;
    out += char;
    used += charWidth;
  }
  return out;
}

export function isAgentActive(agent: WorkflowAgentProgress): boolean {
  return agent.state === "start";
}

export function agentDisplayStatus(input: {
  agent: WorkflowAgentProgress;
  workflowActive: boolean;
}): AgentDisplayStatus {
  const { agent, workflowActive } = input;
  if (agent.skipped) return "skipped";
  if (agent.state === "done") return "done";
  if (agent.state === "error" && agent.stopped) return "interrupted";
  if (agent.state === "error") return "failed";
  if (!workflowActive) return "interrupted";
  return "running";
}

export function statusIconColor(input: { status: AgentDisplayStatus }): {
  glyph: string;
  color: InkColor | undefined;
} {
  return agentStatusGlyph(input.status);
}

function sumSegmentWidth(acc: number, seg: Segment): number {
  return acc + stringWidth(seg.text);
}

function renderSegment(seg: Segment, key: number): React.JSX.Element {
  const weight: { bold: boolean } | { dim: boolean } | {} = seg.bold
    ? { bold: true }
    : seg.dim
      ? { dim: true }
      : {};
  return (
    <Text key={key} {...weight} {...(seg.color ? { color: seg.color } : {})}>
      {seg.text}
    </Text>
  );
}

export function SegmentCell(props: { segs: Segment[]; contentWidth: number }): React.JSX.Element {
  const { segs, contentWidth } = props;
  const used = segs.reduce(sumSegmentWidth, 0);
  const pad = Math.max(0, contentWidth - used);
  return (
    <Text wrap="truncate-end">
      <Text color={Color.text}> {Glyph.boxPipe} </Text>
      {segs.map(renderSegment)}
      {" ".repeat(pad)}
      <Text color={Color.text}> {Glyph.boxPipe}</Text>
    </Text>
  );
}

export function SplitRow(props: {
  left: Segment[];
  right: Segment[];
  leftWidth: number;
  rightWidth: number;
}): React.JSX.Element {
  const { left, right, leftWidth, rightWidth } = props;
  const leftPad = Math.max(0, leftWidth - left.reduce(sumSegmentWidth, 0));
  const rightPad = Math.max(0, rightWidth - right.reduce(sumSegmentWidth, 0));
  return (
    <Text wrap="truncate-end">
      <Text color={Color.text}> {Glyph.boxPipe} </Text>
      {left.map(renderSegment)}
      {" ".repeat(leftPad)}
      <Text color={Color.text}> {Glyph.boxPipe} </Text>
      {right.map(renderSegment)}
      {" ".repeat(rightPad)}
      <Text color={Color.text}> {Glyph.boxPipe}</Text>
    </Text>
  );
}

function buildPaneRuleColumn(input: {
  width: number;
  label?: { text: string; color?: InkColor; bold?: boolean };
  tag?: string;
}): React.JSX.Element[] {
  const { width, label, tag } = input;
  const out: React.JSX.Element[] = [];
  let used = 0;
  if (label) {
    const labelText = ` ${truncateToWidth({ text: label.text, max: Math.max(1, width - PANE_RULE_LABEL_INSET) })} `;
    used += stringWidth(labelText);
    out.push(
      <Text key="label" color={label.color ?? Color.text} {...(label.bold ? { bold: true } : {})}>
        {labelText}
      </Text>,
    );
  }
  const tagText = tag
    ? ` ${truncateToWidth({ text: tag, max: Math.max(0, width - used - PANE_RULE_LABEL_INSET) })} `
    : "";
  const dashCount = Math.max(0, width - used - stringWidth(tagText));
  out.push(
    <Text key="dash" color={Color.text}>
      {Glyph.boxHLine.repeat(dashCount)}
    </Text>,
  );
  if (tagText) {
    out.push(
      <Text key="tag" dim>
        {tagText}
      </Text>,
    );
  }
  return out;
}

export function PaneRule(props: {
  pos: "top" | "bottom";
  leftWidth: number;
  rightWidth: number;
  leftTitle?: string;
  rightTitle?: string;
  leftTag?: string;
  rightTag?: string;
}): React.JSX.Element {
  const { pos, leftWidth, rightWidth, leftTitle, rightTitle, leftTag, rightTag } = props;
  const corner1 = pos === "top" ? Glyph.boxTopLeft : Glyph.boxBottomLeft;
  const tee = pos === "top" ? Glyph.boxTeeDown : Glyph.boxTeeUp;
  const corner2 = pos === "top" ? Glyph.boxTopRight : Glyph.boxBottomRight;
  return (
    <Text wrap="truncate-end">
      <Text color={Color.text}> {corner1}</Text>
      {buildPaneRuleColumn({
        width: leftWidth + PANE_RULE_LABEL_INSET,
        ...(leftTitle ? { label: { text: leftTitle } } : {}),
        ...(leftTag ? { tag: leftTag } : {}),
      })}
      <Text color={Color.text}>{tee}</Text>
      {buildPaneRuleColumn({
        width: rightWidth + PANE_RULE_LABEL_INSET,
        ...(rightTitle ? { label: { text: rightTitle } } : {}),
        ...(rightTag ? { tag: rightTag } : {}),
      })}
      <Text color={Color.text}>{corner2}</Text>
    </Text>
  );
}

function phaseGlyph(input: { isDone: boolean; isFailed: boolean; index: number }): string {
  const { isDone, isFailed, index } = input;
  if (isDone) return TICK;
  if (isFailed) return CROSS;
  return String(index + 1);
}

function phaseGlyphColor(input: {
  selected: boolean;
  isDone: boolean;
  isFailed: boolean;
}): InkColor {
  const { selected, isDone, isFailed } = input;
  if (selected) return Color.primaryGlow;
  if (isDone) return Color.success;
  if (isFailed) return Color.error;
  return Color.subtle;
}

export function buildPhaseRowSegments(input: {
  phase: MergedPhase;
  index: number;
  selectedIndex: number;
  level: "phases" | "agents";
  width: number;
}): Segment[] {
  const { phase, index, selectedIndex, level, width } = input;
  const selected = index === selectedIndex;
  const isDone = phase.status === "done";
  const isFailed = phase.status === "failed";
  const glyph = phaseGlyph({ isDone, isFailed, index });
  const glyphColor = phaseGlyphColor({ selected, isDone, isFailed });
  const counts = phase.totalCount > 0 ? `${phase.doneCount}/${phase.totalCount}` : "";
  const pointer = level === "phases" && selected ? Glyph.chevron : "  ";
  const prefixWidth = stringWidth(pointer) + stringWidth(glyph) + 1;
  const countsWidth = counts ? 1 + stringWidth(counts) : 0;
  const title = truncateToWidth({
    text: phase.title,
    max: Math.max(1, width - prefixWidth - countsWidth),
  });
  const trailingPad = Math.max(0, width - prefixWidth - stringWidth(title) - countsWidth);
  const dimmed = !selected && phase.status === "not-started";
  const segs: Segment[] = [
    seg({ text: pointer, ...(selected ? { color: Color.primaryGlow } : {}) }),
    { text: glyph, color: glyphColor },
    { text: " " },
    seg({
      text: title,
      ...(selected ? { color: Color.primaryGlow } : {}),
      dim: dimmed,
    }),
    { text: " ".repeat(trailingPad) },
  ];
  if (counts) {
    segs.push({ text: " " }, { text: counts, color: selected ? Color.primaryGlow : Color.subtle });
  }
  return segs;
}

function buildAgentMetaParts(input: { agent: WorkflowAgentProgress; workflowActive: boolean }): {
  model: string;
  stats: string;
} {
  const { agent, workflowActive } = input;
  const status = agentDisplayStatus({ agent, workflowActive });
  const model = agent.model ?? "";
  const parts: string[] = [];
  if (agent.tokens != null) parts.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls != null && agent.toolCalls > 0) {
    parts.push(`${agent.toolCalls} ${pluralize(agent.toolCalls, "tool")}`);
  }
  if (status === "done") parts.push(formatDuration(agent.lastProgressAt - agent.startedAt));
  return { model, stats: parts.join(TRAILER_SEPARATOR) };
}

export function buildAgentTrailerSegments(input: {
  agent: WorkflowAgentProgress;
  width: number;
  selected: boolean;
  workflowActive: boolean;
}): Segment[] {
  const { agent, width, selected, workflowActive } = input;
  if (width <= 0) return [];
  const { model, stats } = buildAgentMetaParts({ agent, workflowActive });
  const color = selected ? Color.primaryGlow : undefined;
  const dim = !selected;
  let modelText = model;
  let statsText = stats;
  const sep = modelText && statsText ? 1 : 0;
  if (stringWidth(modelText) + sep + stringWidth(statsText) > width) {
    statsText = truncateToWidth({ text: statsText, max: width - stringWidth(modelText) - sep });
    if (
      stringWidth(modelText) + (modelText && statsText ? 1 : 0) + stringWidth(statsText) >
      width
    ) {
      modelText = truncateToWidth({
        text: modelText,
        max: width - stringWidth(statsText) - (statsText ? 1 : 0),
      });
    }
  }
  const gap = Math.max(0, width - stringWidth(modelText) - stringWidth(statsText));
  const paint = { ...(color ? { color } : {}), dim };
  return [
    seg({ text: modelText, ...paint }),
    { text: " ".repeat(gap) },
    seg({ text: statsText, ...paint }),
  ];
}

export function buildAgentRowSegments(input: {
  agent: WorkflowAgentProgress;
  index: number;
  selectedIndex: number;
  level: "phases" | "agents";
  width: number;
  labelWidth: number;
  workflowActive: boolean;
}): Segment[] {
  const { agent, index, selectedIndex, level, width, labelWidth, workflowActive } = input;
  const selected = level === "agents" && index === selectedIndex;
  const { glyph, color } = statusIconColor({
    status: agentDisplayStatus({ agent, workflowActive }),
  });
  const label = truncateToWidth({ text: agent.label, max: labelWidth });
  const labelPad = " ".repeat(Math.max(0, labelWidth - stringWidth(label)));
  const trailerWidth = Math.max(0, width - (labelWidth + AGENT_ROW_TRAILER_INSET));
  return [
    { text: selected ? Glyph.chevron.trimEnd() : " ", color: Color.primaryGlow },
    { text: glyph, color, dim: !selected && isAgentActive(agent) },
    { text: " " },
    seg({
      text: `${label}${labelPad}`,
      ...(selected ? { color: Color.primaryGlow } : {}),
      dim: !selected && isAgentActive(agent),
    }),
    { text: " " },
    ...buildAgentTrailerSegments({ agent, width: trailerWidth, selected, workflowActive }),
  ];
}

export function buildAgentLabelSegments(input: {
  agent: WorkflowAgentProgress;
  index: number;
  selectedIndex: number;
  width: number;
  workflowActive: boolean;
}): Segment[] {
  const { agent, index, selectedIndex, width, workflowActive } = input;
  const selected = index === selectedIndex;
  const { glyph, color } = statusIconColor({
    status: agentDisplayStatus({ agent, workflowActive }),
  });
  const label = truncateToWidth({ text: agent.label, max: Math.max(1, width - AGENT_LABEL_INSET) });
  return [
    { text: selected ? Glyph.chevron : "  ", color: Color.primaryGlow },
    { text: glyph, color, dim: !selected && isAgentActive(agent) },
    { text: " " },
    seg({
      text: label,
      ...(selected ? { color: Color.primaryGlow } : {}),
      dim: !selected && isAgentActive(agent),
    }),
  ];
}
