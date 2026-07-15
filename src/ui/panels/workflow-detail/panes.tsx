import type React from "react";
import type { MergedPhase } from "@/engine/background/workflows/runtime/progress/merge.ts";
import { Box, Text } from "@/ink";
import { computeListWindow, formatScrollWindowLabel } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import {
  agentDisplayStatus,
  buildAgentLabelSegments,
  buildAgentRowSegments,
  buildAgentTrailerSegments,
  buildPhaseRowSegments,
  isAgentActive,
  PaneRule,
  type Segment,
  SegmentCell,
  SplitRow,
  seg,
  statusIconColor,
  truncateToWidth,
} from "./segments.tsx";

const MIDDOT = " · ";
const TRAILER_MAX = 24;
const TRAILER_MIN = 6;
const TRAILER_FRACTION = 0.42;
const RULE_INSET = 2;
const HEADER_LINES_TIGHT = 1;
const HEADER_LINES_WIDE = 3;
const AGENT_LIST_FOOTER_ROWS = 2;
const LIST_LABEL_MAX = 22;
const LIST_LABEL_MIN = 4;
const LIST_LABEL_INSET = 5;
const LIST_TRAILER_INSET = 5;

export function PhaseAgentSplitPane(props: {
  phases: MergedPhase[];
  selectedPhase: MergedPhase;
  clampedPhase: number;
  clampedAgent: number;
  level: "phases" | "agents";
  leftWidth: number;
  rightWidth: number;
  viewport: number;
  workflowActive: boolean;
}): React.JSX.Element {
  const {
    phases,
    selectedPhase,
    clampedPhase,
    clampedAgent,
    level,
    leftWidth,
    rightWidth,
    viewport,
    workflowActive,
  } = props;
  const agents = selectedPhase.agents;
  const phaseWin = computeListWindow({
    cursor: clampedPhase,
    total: phases.length,
    size: viewport,
    anchor: "center",
  });
  const agentWin = computeListWindow({
    cursor: clampedAgent,
    total: agents.length,
    size: viewport,
    anchor: "center",
  });
  const trailerWidth = Math.min(
    TRAILER_MAX,
    Math.max(TRAILER_MIN, Math.floor(rightWidth * TRAILER_FRACTION)),
  );
  const rows: React.JSX.Element[] = [];
  for (let i = 0; i < viewport; i++) {
    const phaseRow = phaseWin.from + i;
    const agentRow = agentWin.from + i;
    const phaseAtRow = phaseRow < phaseWin.to ? phases[phaseRow] : undefined;
    const left = phaseAtRow
      ? buildPhaseRowSegments({
          phase: phaseAtRow,
          index: phaseRow,
          selectedIndex: clampedPhase,
          level,
          width: leftWidth,
        })
      : [];
    let right: Segment[] = [];
    const agentAtRow = agentRow < agentWin.to ? agents[agentRow] : undefined;
    if (agentAtRow) {
      right = buildAgentRowSegments({
        agent: agentAtRow,
        index: agentRow,
        selectedIndex: clampedAgent,
        level,
        width: rightWidth,
        labelWidth: trailerWidth,
        workflowActive,
      });
    } else if (agents.length === 0 && i === 0) {
      right = [
        {
          text: selectedPhase.status === "not-started" ? "Not started yet" : "No agents",
          dim: true,
        },
      ];
    }
    rows.push(
      <SplitRow key={i} left={left} right={right} leftWidth={leftWidth} rightWidth={rightWidth} />,
    );
  }
  const rightTitle = `${selectedPhase.title}${MIDDOT}${agents.length} ${pluralize(agents.length, "agent")}`;
  return (
    <Box flexDirection="column">
      <PaneRule
        pos="top"
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        leftTitle="Phases"
        rightTitle={rightTitle}
      />
      {rows}
      <PaneRule
        pos="bottom"
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        {...(phases.length > viewport
          ? { leftTag: formatScrollWindowLabel({ win: phaseWin, total: phases.length }) }
          : {})}
        {...(agents.length > viewport
          ? { rightTag: formatScrollWindowLabel({ win: agentWin, total: agents.length }) }
          : {})}
      />
    </Box>
  );
}

export function AgentDetailSplitPane(props: {
  phase: MergedPhase;
  clampedAgent: number;
  agentLabel: string;
  detailLines: Segment[][];
  cardScroll: number;
  leftWidth: number;
  rightWidth: number;
  viewport: number;
  workflowActive: boolean;
}): React.JSX.Element {
  const {
    phase,
    clampedAgent,
    agentLabel,
    detailLines,
    cardScroll,
    leftWidth,
    rightWidth,
    viewport,
    workflowActive,
  } = props;
  const agents = phase.agents;
  const agentWin = computeListWindow({
    cursor: clampedAgent,
    total: agents.length,
    size: viewport,
    anchor: "center",
  });
  const maxScroll = Math.max(0, detailLines.length - viewport);
  const scrollTop = clamp(cardScroll, 0, maxScroll);
  const scrollBottom = Math.min(detailLines.length, scrollTop + viewport);
  const rows: React.JSX.Element[] = [];
  for (let i = 0; i < viewport; i++) {
    const agentRow = agentWin.from + i;
    const agentAtRow = agentRow < agentWin.to ? agents[agentRow] : undefined;
    const left = agentAtRow
      ? buildAgentLabelSegments({
          agent: agentAtRow,
          index: agentRow,
          selectedIndex: clampedAgent,
          width: leftWidth,
          workflowActive,
        })
      : [];
    const detailRow = scrollTop + i;
    const right = detailRow < scrollBottom ? (detailLines[detailRow] ?? []) : [];
    rows.push(
      <SplitRow key={i} left={left} right={right} leftWidth={leftWidth} rightWidth={rightWidth} />,
    );
  }
  const leftTitle = `${phase.title}${MIDDOT}${agents.length} ${pluralize(agents.length, "agent")}`;
  return (
    <Box flexDirection="column">
      <PaneRule
        pos="top"
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        leftTitle={leftTitle}
        rightTitle={agentLabel}
      />
      {rows}
      <PaneRule
        pos="bottom"
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        {...(agents.length > viewport
          ? { leftTag: formatScrollWindowLabel({ win: agentWin, total: agents.length }) }
          : {})}
        {...(detailLines.length > viewport
          ? {
              rightTag: formatScrollWindowLabel({
                win: { from: scrollTop, to: scrollBottom },
                total: detailLines.length,
              }),
            }
          : {})}
      />
    </Box>
  );
}

export function AgentDetailSinglePane(props: {
  agentLabel: string;
  position: string;
  detailLines: Segment[][];
  cardScroll: number;
  contentWidth: number;
  viewport: number;
}): React.JSX.Element {
  const { agentLabel, position, detailLines, cardScroll, contentWidth, viewport } = props;
  const rule = Glyph.boxHLine.repeat(contentWidth + RULE_INSET);
  const maxScroll = Math.max(0, detailLines.length - viewport);
  const scrollTop = clamp(cardScroll, 0, maxScroll);
  const scrollBottom = Math.min(detailLines.length, scrollTop + viewport);
  const positionText = `${MIDDOT}${position}`;
  const titleText = truncateToWidth({
    text: agentLabel,
    max: Math.max(1, contentWidth - stringWidth(positionText)),
  });
  const body: React.JSX.Element[] = [];
  body.push(
    <SegmentCell
      key="title"
      contentWidth={contentWidth}
      segs={[
        { text: titleText, color: Color.primaryGlow, bold: true },
        { text: positionText, dim: true },
      ]}
    />,
  );
  for (let i = scrollTop; i < scrollBottom; i++) {
    const line = detailLines[i];
    if (!line) continue;
    body.push(<SegmentCell key={`l-${i}`} contentWidth={contentWidth} segs={line} />);
  }
  for (let i = scrollBottom - scrollTop; i < viewport; i++) {
    body.push(<SegmentCell key={`pad-${i}`} contentWidth={contentWidth} segs={[{ text: "" }]} />);
  }
  let bottom: React.JSX.Element;
  if (detailLines.length > viewport) {
    const label = ` ${formatScrollWindowLabel({
      win: { from: scrollTop, to: scrollBottom },
      total: detailLines.length,
    })} `;
    const dashCount = Math.max(0, contentWidth + RULE_INSET - stringWidth(label));
    bottom = (
      <Text wrap="truncate-end">
        <Text color={Color.text}>
          {" "}
          {Glyph.boxBottomLeft}
          {Glyph.boxHLine.repeat(dashCount)}
        </Text>
        <Text dim>{label}</Text>
        <Text color={Color.text}>{Glyph.boxBottomRight}</Text>
      </Text>
    );
  } else {
    bottom = (
      <Text color={Color.text} wrap="truncate-end">
        {" "}
        {Glyph.boxBottomLeft}
        {rule}
        {Glyph.boxBottomRight}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={Color.text} wrap="truncate-end">
        {" "}
        {Glyph.boxTopLeft}
        {rule}
        {Glyph.boxTopRight}
      </Text>
      {body}
      {bottom}
    </Box>
  );
}

export function AgentListSinglePane(props: {
  phase: MergedPhase;
  selectedAgent: number;
  level: "phases" | "agents";
  contentWidth: number;
  viewport: number;
  tight: boolean;
  workflowActive: boolean;
}): React.JSX.Element {
  const { phase, selectedAgent, level, contentWidth, viewport, tight, workflowActive } = props;
  const agents = phase.agents;
  const rule = Glyph.boxHLine.repeat(contentWidth + RULE_INSET);
  const headerLines = tight ? HEADER_LINES_TIGHT : HEADER_LINES_WIDE;
  const agentRows = Math.max(1, viewport - headerLines - AGENT_LIST_FOOTER_ROWS);
  const agentWin = computeListWindow({
    cursor: selectedAgent,
    total: agents.length,
    size: agentRows,
    anchor: "center",
  });
  const header: React.JSX.Element[] = [];
  const countLabel = `${agents.length} ${pluralize(agents.length, "agent")}`;
  if (tight) {
    const trailer = `${MIDDOT}${countLabel}`;
    const titleText = truncateToWidth({
      text: phase.title,
      max: Math.max(1, contentWidth - stringWidth(trailer)),
    });
    header.push(
      <SegmentCell
        key="title"
        contentWidth={contentWidth}
        segs={[
          { text: titleText, color: Color.primaryGlow, bold: true },
          { text: trailer, dim: true },
        ]}
      />,
    );
  } else {
    const titleText = truncateToWidth({ text: phase.title, max: contentWidth });
    header.push(
      <SegmentCell
        key="title"
        contentWidth={contentWidth}
        segs={[{ text: titleText, color: Color.primaryGlow, bold: true }]}
      />,
    );
    header.push(
      <SegmentCell
        key="count"
        contentWidth={contentWidth}
        segs={[{ text: countLabel, dim: true }]}
      />,
    );
    header.push(<SegmentCell key="gap" contentWidth={contentWidth} segs={[{ text: "" }]} />);
  }
  const headerCount = header.length;
  if (agents.length === 0) {
    const emptyText = phase.status === "not-started" ? "Not started yet" : "No agents";
    header.push(
      <SegmentCell
        key="empty"
        contentWidth={contentWidth}
        segs={[{ text: emptyText, dim: true }]}
      />,
    );
  } else {
    const labelWidth = Math.min(
      LIST_LABEL_MAX,
      Math.max(LIST_LABEL_MIN, contentWidth - LIST_LABEL_INSET),
    );
    for (let i = agentWin.from; i < agentWin.to; i++) {
      const agent = agents[i];
      if (!agent) continue;
      const selected = level === "agents" && i === selectedAgent;
      const { glyph, color } = statusIconColor({
        status: agentDisplayStatus({ agent, workflowActive }),
      });
      const label = truncateToWidth({ text: agent.label, max: labelWidth });
      const labelPad = " ".repeat(Math.max(0, labelWidth - stringWidth(label)));
      const trailerWidth = Math.max(0, contentWidth - (labelWidth + LIST_TRAILER_INSET));
      header.push(
        <SegmentCell
          key={`a-${i}`}
          contentWidth={contentWidth}
          segs={[
            { text: selected ? Glyph.chevron.trimEnd() : " ", color: Color.primaryGlow },
            { text: " " },
            { text: glyph, color, dim: !selected && isAgentActive(agent) },
            { text: " " },
            seg({
              text: `${label}${labelPad}`,
              ...(selected ? { color: Color.primaryGlow } : {}),
              dim: !selected && isAgentActive(agent),
            }),
            { text: " " },
            ...buildAgentTrailerSegments({
              agent,
              width: trailerWidth,
              selected,
              workflowActive,
            }),
          ]}
        />,
      );
    }
  }
  const rendered = header.length - headerCount;
  for (let i = rendered; i < agentRows; i++) {
    header.push(<SegmentCell key={`pad-${i}`} contentWidth={contentWidth} segs={[{ text: "" }]} />);
  }
  let bottom: React.JSX.Element;
  if (agents.length > agentRows) {
    const label = ` ${formatScrollWindowLabel({ win: agentWin, total: agents.length })} `;
    const dashCount = Math.max(0, contentWidth + RULE_INSET - stringWidth(label));
    bottom = (
      <Text wrap="truncate-end">
        <Text color={Color.text}>
          {" "}
          {Glyph.boxBottomLeft}
          {Glyph.boxHLine.repeat(dashCount)}
        </Text>
        <Text dim>{label}</Text>
        <Text color={Color.text}>{Glyph.boxBottomRight}</Text>
      </Text>
    );
  } else {
    bottom = (
      <Text color={Color.text} wrap="truncate-end">
        {" "}
        {Glyph.boxBottomLeft}
        {rule}
        {Glyph.boxBottomRight}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={Color.text} wrap="truncate-end">
        {" "}
        {Glyph.boxTopLeft}
        {rule}
        {Glyph.boxTopRight}
      </Text>
      {header}
      {bottom}
    </Box>
  );
}
