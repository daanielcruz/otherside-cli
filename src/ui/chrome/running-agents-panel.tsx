import React, { memo, useRef, useState, useSyncExternalStore } from "react";
import {
  pendingAgentSteerCount,
  subscribeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import type { Color as InkColor } from "@/ink";
import { Box, Text, useRepeatingClock, useTerminalDimensions } from "@/ink";
import { clamp } from "@/kernel/std/math.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import {
  MAX_STATUS_LABEL_WIDTH,
  MIN_STATUS_LABEL_WIDTH,
  statusLabelPadding,
} from "@/ui/chrome/progress/geometry.ts";
import { BULLET_IDLE, BULLET_VIEWED } from "@/ui/chrome/progress/glyphs.ts";
import {
  buildWorkflowRowParts,
  isTerminalWorkflowStatus,
  type WorkflowRowParts,
} from "@/ui/chrome/progress/workflow-row.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const MAX_VISIBLE_ROWS = 5;
// Statusline + status bar + prompt/input + dividers/spacers + five transcript rows.
const IDLE_NON_PANEL_ROW_RESERVE = 10;
const PANEL_FIXED_ROWS = 2; // marginTop + trailing spacer

export interface PanelRowAllocation {
  agentRows: number;
  workflowRows: number;
}

export function panelRowAllocation(
  terminalRows: number,
  mainLlmBusy: boolean,
  agentCount: number,
  workflowCount: number,
): PanelRowAllocation {
  if (mainLlmBusy) {
    return {
      agentRows: Math.min(agentCount, MAX_VISIBLE_ROWS),
      workflowRows: Math.min(workflowCount, MAX_VISIBLE_ROWS),
    };
  }

  // Keep the footer from displacing the transcript: the panel may use the
  // rows left after statusline, status bar, prompt/input, separators, its
  // margin/spacer, and a modest five-row transcript surface. Reserve one
  // possible overflow line for each namespace before allocating list rows.
  const contentRows = Math.max(0, terminalRows - IDLE_NON_PANEL_ROW_RESERVE);
  const mainRows = agentCount > 0 ? 1 : 0;
  const overflowRows = (agentCount > 0 ? 1 : 0) + (workflowCount > 0 ? 1 : 0);
  const listRows = Math.max(0, contentRows - PANEL_FIXED_ROWS - mainRows - overflowRows);

  if (agentCount === 0) {
    return { agentRows: 0, workflowRows: Math.min(workflowCount, listRows) };
  }
  if (workflowCount === 0) {
    return { agentRows: Math.min(agentCount, listRows), workflowRows: 0 };
  }
  if (listRows < 2) return { agentRows: 0, workflowRows: 0 };

  // Split the shared list capacity in proportion to each namespace, while
  // retaining at least one row for both whenever the terminal has room.
  let agentRows = Math.max(1, Math.floor((listRows * agentCount) / (agentCount + workflowCount)));
  let workflowRows = Math.max(1, listRows - agentRows);
  agentRows = Math.min(agentRows, agentCount);
  workflowRows = Math.min(workflowRows, workflowCount);

  let remaining = listRows - agentRows - workflowRows;
  while (remaining > 0 && (agentRows < agentCount || workflowRows < workflowCount)) {
    if (agentRows < agentCount && (workflowRows >= workflowCount || agentRows <= workflowRows)) {
      agentRows++;
    } else if (workflowRows < workflowCount) {
      workflowRows++;
    }
    remaining--;
  }

  return { agentRows, workflowRows };
}

type AgentSelection = { namespace: "agents"; index: number };
type WorkflowSelection = { namespace: "workflows"; index: number };
export type PanelSelection = AgentSelection | WorkflowSelection;

export function panelSelectionFor(selection: number, agentCount: number): PanelSelection {
  if (agentCount === 0) return { namespace: "workflows", index: selection };
  if (selection <= agentCount) return { namespace: "agents", index: selection };
  return { namespace: "workflows", index: selection - agentCount - 1 };
}

export function remapPanelSelectionForAgentCountChange(
  selection: number,
  prevAgentCount: number,
  nextAgentCount: number,
): number {
  if (prevAgentCount === nextAgentCount) return selection;
  const resolved = panelSelectionFor(selection, prevAgentCount);
  if (resolved.namespace !== "workflows") return selection;
  return nextAgentCount > 0 ? resolved.index + nextAgentCount + 1 : resolved.index;
}

export interface RunningAgentsPanelProps {
  agents: BackgroundTask[];
  workflows: LocalWorkflowTaskState[];
  selection: PanelSelection | undefined;
  focusInPanel: boolean;
  viewingAgentId: string | undefined;
  mainLlmBusy: boolean;
}

interface AgentStatusParts {
  elapsed: string;
  tokenText: string;
  queuedText: string;
  queuedCount: number;
  renderedText: React.JSX.Element;
}

// Selection slides the window by its edges (top/bottom row), never recentering; counters move one step per keypress.
export function panelWindowStart(
  prev: number,
  selectedIdx: number,
  total: number,
  visibleRows: number,
): number {
  const maxStart = Math.max(0, total - visibleRows);
  let start = clamp(prev, 0, maxStart);
  if (selectedIdx >= 0 && visibleRows > 0) {
    if (selectedIdx < start) start = selectedIdx;
    else if (selectedIdx >= start + visibleRows) start = selectedIdx - visibleRows + 1;
  }
  return clamp(start, 0, maxStart);
}

function RunningAgentsPanelImpl({
  agents,
  workflows,
  selection,
  focusInPanel,
  viewingAgentId,
  mainLlmBusy,
}: RunningAgentsPanelProps): React.JSX.Element | null {
  useLiveTick(agents, workflows);
  const { rows: terminalRows } = useTerminalDimensions();
  useSyncExternalStore(
    subscribeAgentSteers,
    () =>
      agents.reduce(
        (total, task) => total + (task.forkId ? pendingAgentSteerCount(task.forkId) : 0),
        0,
      ),
    () => 0,
  );
  const agentWindowStartRef = useRef(0);
  const workflowWindowStartRef = useRef(0);

  if (agents.length === 0 && workflows.length === 0) return null;

  const now = Date.now();
  const agentStatuses = agents.map((t) => buildAgentStatus(t, now));
  const workflowParts = workflows.map((t) => buildWorkflowRowParts(t, now));

  // Label column must fit connector + name + hidden-count badge, or the name
  // gets squeezed into an ellipsis whenever a badge is present.
  const agentLabelWidths = agents.map(
    (t) => stringWidth(agentConnector(t)) + stringWidth(t.agentName) + stringWidth(hiddenSuffix(t)),
  );
  const workflowLabelWidths = workflowParts.map((p) => stringWidth(p.name));
  const labelWidth = clamp(
    Math.max(0, ...agentLabelWidths, ...workflowLabelWidths),
    MIN_STATUS_LABEL_WIDTH,
    MAX_STATUS_LABEL_WIDTH,
  );

  const agentIdx = selection?.namespace === "agents" ? selection.index : undefined;
  const workflowIdx = selection?.namespace === "workflows" ? selection.index : undefined;

  const mainHighlighted = focusInPanel && agentIdx === 0;
  const mainViewed = viewingAgentId === undefined;

  const hasAgents = agents.length > 0;
  const { agentRows, workflowRows } = panelRowAllocation(
    terminalRows,
    mainLlmBusy,
    agents.length,
    workflows.length,
  );

  const totalAgents = agents.length;
  const selectedAgentIdx = selection?.namespace === "agents" ? selection.index - 1 : -1;
  const agentWindowStart = panelWindowStart(
    agentWindowStartRef.current,
    selectedAgentIdx,
    totalAgents,
    agentRows,
  );
  agentWindowStartRef.current = agentWindowStart;
  const agentWindowEnd = Math.min(totalAgents, agentWindowStart + agentRows);

  const visibleAgents = agents.slice(agentWindowStart, agentWindowEnd);
  const agentMoreUpCount = agentWindowStart;
  const agentMoreDownCount = totalAgents - agentWindowEnd;

  const totalWorkflows = workflows.length;
  const selectedWorkflowIdx = selection?.namespace === "workflows" ? selection.index : -1;
  const workflowWindowStart = panelWindowStart(
    workflowWindowStartRef.current,
    selectedWorkflowIdx,
    totalWorkflows,
    workflowRows,
  );
  workflowWindowStartRef.current = workflowWindowStart;
  const workflowWindowEnd = Math.min(totalWorkflows, workflowWindowStart + workflowRows);
  const visibleWorkflowParts = workflowParts.slice(workflowWindowStart, workflowWindowEnd);
  const workflowMoreUpCount = workflowWindowStart;
  const workflowMoreDownCount = totalWorkflows - workflowWindowEnd;

  return (
    <Box flexDirection="column" marginTop={1} paddingRight={2}>
      {hasAgents && (
        <PanelMainLine
          highlighted={mainHighlighted}
          viewed={mainViewed}
          labelWidth={labelWidth}
          moreUpCount={agentMoreUpCount}
        />
      )}
      {visibleAgents.map((task, i) => {
        const actualIndex = agentWindowStart + i;
        // Nested rows keep their gutter on every page; when the parent row
        // scrolled above the window the branch renders as a continuation (├,
        // never the closing └) so the tree reads as carried over the fold.
        let connectorContinuation = false;
        if (task.depth && task.depth > 1) {
          for (let j = actualIndex - 1; j >= 0; j--) {
            if ((agents[j]?.depth ?? 1) < task.depth) {
              connectorContinuation = j < agentWindowStart;
              break;
            }
          }
        }
        return (
          <PanelAgentLine
            key={`agent-${task.id}`}
            task={task}
            labelWidth={labelWidth}
            status={agentStatuses[actualIndex] ?? buildAgentStatus(task, now)}
            highlighted={focusInPanel && agentIdx === actualIndex + 1}
            viewed={viewingAgentId === task.id}
            connectorContinuation={connectorContinuation}
          />
        );
      })}
      {agentMoreDownCount > 0 && <PanelMoreLine direction="down" count={agentMoreDownCount} />}
      {workflowMoreUpCount > 0 && <PanelMoreLine direction="up" count={workflowMoreUpCount} />}
      {visibleWorkflowParts.map((parts, i) => {
        const actualIndex = workflowWindowStart + i;
        return (
          <PanelWorkflowLine
            key={`workflow-${workflows[actualIndex]?.id ?? actualIndex}`}
            parts={parts}
            labelWidth={labelWidth}
            selected={workflowIdx === actualIndex}
          />
        );
      })}
      {workflowMoreDownCount > 0 && (
        <PanelMoreLine direction="down" count={workflowMoreDownCount} />
      )}
    </Box>
  );
}

export function runningPanelHint(
  focusInPanel: boolean,
  focusedAgent: BackgroundTask | undefined,
  focusedWorkflow: LocalWorkflowTaskState | undefined,
  activeAgentCount?: number,
  columns?: number,
): string | undefined {
  if (!focusInPanel) return undefined;

  let baseHint = "enter to view";

  if (focusedAgent) {
    const isTerminal =
      focusedAgent.status === "completed" ||
      focusedAgent.status === "error" ||
      focusedAgent.status === "killed";
    baseHint = `enter to view · x to ${isTerminal ? "clear" : "stop"}`;
  } else if (focusedWorkflow) {
    baseHint = `enter to view · x to ${workflowStopAction(focusedWorkflow.status)}`;
  }

  if (activeAgentCount !== undefined && columns !== undefined) {
    if (activeAgentCount >= 2 && columns >= 90) {
      baseHint += " · ctrl+x ctrl+k to stop all agents";
    }
  }

  return baseHint;
}

function workflowStopAction(status: LocalWorkflowTaskState["status"]): string {
  if (status === "running") return "pause";
  if (status === "paused") return "kill";
  return "clear";
}

function PanelMainLine({
  highlighted,
  viewed,
  labelWidth,
  moreUpCount,
}: {
  highlighted: boolean;
  viewed: boolean;
  labelWidth: number;
  moreUpCount: number;
}): React.JSX.Element {
  const prefix = highlighted ? Glyph.chevron : "  ";
  const bullet = viewed ? BULLET_VIEWED : BULLET_IDLE;
  const dim = !highlighted && !viewed;
  return (
    <Box>
      <Box width={labelWidth + statusLabelPadding()} flexShrink={0}>
        <Text color={highlighted ? Color.primaryGlow : Color.muted}>{prefix}</Text>
        <Text color={dim ? Color.muted : Color.text} bold={viewed}>
          {`${bullet} main`}
        </Text>
      </Box>
      <Box flexGrow={1} />
      {moreUpCount > 0 && <Text color={Color.muted}>{`↑ ${moreUpCount} more`}</Text>}
    </Box>
  );
}

function PanelMoreLine({
  direction,
  count,
}: {
  direction: "up" | "down";
  count: number;
}): React.JSX.Element {
  return (
    <Box justifyContent="flex-end">
      <Text color={Color.muted}>{`${direction === "up" ? "↑" : "↓"} ${count} more`}</Text>
    </Box>
  );
}

function PanelAgentLine({
  task,
  labelWidth,
  status,
  highlighted,
  viewed,
  connectorContinuation = false,
}: {
  task: BackgroundTask;
  labelWidth: number;
  status: AgentStatusParts;
  highlighted: boolean;
  viewed: boolean;
  connectorContinuation?: boolean;
}): React.JSX.Element {
  const dim = !highlighted && !viewed;
  const prefix = highlighted ? Glyph.chevron : "  ";
  const bullet = viewed ? BULLET_VIEWED : BULLET_IDLE;

  let bulletColor: InkColor | undefined;
  if (task.status === "completed") {
    bulletColor = Color.success;
  } else if (task.status === "error" || task.status === "killed") {
    bulletColor = Color.error;
  } else {
    bulletColor = dim ? Color.muted : Color.text;
  }

  const connector = connectorContinuation
    ? "  ".repeat(Math.max(0, (task.depth ?? 2) - 2)) + "├ "
    : agentConnector(task);

  const adjustedLabelWidth = Math.max(1, labelWidth - stringWidth(connector));

  const description = task.description ?? "";
  const hiddenCountSuffix = hiddenSuffix(task);
  const suffixWidth = stringWidth(hiddenCountSuffix);
  const nameWidth = Math.max(1, adjustedLabelWidth - suffixWidth);

  return (
    <Box>
      <Box flexShrink={0}>
        <Text color={highlighted ? Color.primaryGlow : Color.muted}>{prefix}</Text>
      </Box>
      {connector ? (
        <Box flexShrink={0}>
          <Text color={Color.muted}>{connector}</Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text color={bulletColor}>{bullet + " "}</Text>
      </Box>
      <Box width={nameWidth} flexShrink={0}>
        <Text color={dim ? Color.muted : Color.text} bold={viewed} wrap="truncate">
          {task.agentName}
        </Text>
      </Box>
      {hiddenCountSuffix && (
        <Box flexShrink={0}>
          <Text color={Color.muted}>{hiddenCountSuffix}</Text>
        </Box>
      )}
      <Box flexGrow={1} width={0} paddingLeft={2}>
        <Text color={Color.muted} wrap="truncate">
          {description}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
        {status.renderedText}
      </Box>
    </Box>
  );
}

function PanelWorkflowLine({
  parts,
  labelWidth,
  selected,
}: {
  parts: WorkflowRowParts;
  labelWidth: number;
  selected: boolean;
}): React.JSX.Element {
  const dim = !selected;
  const prefix = selected ? Glyph.chevron : "  ";
  return (
    <Box>
      <Box flexShrink={0}>
        <Text color={selected ? Color.primaryGlow : Color.muted}>{prefix}</Text>
      </Box>
      <Box flexShrink={0}>
        {parts.bulletColor !== undefined ? (
          <Text color={parts.bulletColor}>{`${BULLET_IDLE} `}</Text>
        ) : (
          <Text color={Color.muted}>{`${BULLET_IDLE} `}</Text>
        )}
      </Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={dim ? Color.muted : Color.text} wrap="truncate">
          {parts.name}
        </Text>
      </Box>
      <Box flexGrow={1} width={0} paddingLeft={2}>
        <Text color={Color.muted} wrap="truncate">
          {parts.description}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
        <Text color={Color.muted}>{parts.statusText}</Text>
      </Box>
    </Box>
  );
}

function agentConnector(task: BackgroundTask): string {
  return task.depth && task.depth > 1
    ? "  ".repeat(task.depth - 2) + (task.hasLaterSibling ? "├" : "└") + " "
    : "";
}

function hiddenSuffix(task: BackgroundTask): string {
  return task.transitiveHiddenCount && task.transitiveHiddenCount > 0
    ? ` (+${task.transitiveHiddenCount})`
    : "";
}

function buildAgentStatus(task: BackgroundTask, now: number): AgentStatusParts {
  const isRunning = task.status === "running";
  const elapsedMs = isRunning
    ? now - task.startedAt
    : (task.endedAt ?? task.startedAt) - task.startedAt;
  const tokenCount = task.inputTokens + task.outputTokens;

  let arrow = "↑";
  if (isRunning) {
    arrow = "↓";
  }
  const tokenText = tokenCount > 0 ? `${arrow} ${formatTokens(tokenCount)} tokens` : "";

  const elapsed = formatDuration(elapsedMs);

  const parts: React.ReactNode[] = [];
  parts.push(<Text color={Color.muted}>{elapsed}</Text>);
  if (tokenText) {
    parts.push(<Text color={Color.muted}>{tokenText}</Text>);
  }

  const queuedCount =
    isRunning && task.forkId !== undefined ? pendingAgentSteerCount(task.forkId) : 0;
  const queuedText = queuedCount > 0 ? `${queuedCount} queued` : "";

  const renderedParts: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      renderedParts.push(
        <Text key={`sep-${i}`} color={Color.muted}>
          {" · "}
        </Text>,
      );
    }
    renderedParts.push(<React.Fragment key={`part-${i}`}>{parts[i]}</React.Fragment>);
  }
  if (queuedText) {
    renderedParts.push(<Text key="queued" color={Color.warning}>{` · ${queuedText}`}</Text>);
  }

  return {
    elapsed,
    tokenText,
    queuedText,
    queuedCount,
    renderedText: <Text>{renderedParts}</Text>,
  };
}

function useLiveTick(agents: BackgroundTask[], workflows: LocalWorkflowTaskState[]): void {
  const [, setTick] = useState(0);
  const hasRunning =
    agents.some((t) => t.status === "running") ||
    workflows.some((t) => !isTerminalWorkflowStatus(t.status));
  useRepeatingClock(
    () => {
      setTick((n) => n + 1);
    },
    hasRunning ? 1000 : null,
  );
}

export const RunningAgentsPanel = memo(RunningAgentsPanelImpl);
