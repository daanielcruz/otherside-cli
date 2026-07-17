import React, { memo, useRef, useState, useSyncExternalStore } from "react";
import {
  pendingAgentSteerCount,
  subscribeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";
import {
  type BackgroundTask,
  list as listBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { aggregateSubtreeProgress } from "@/engine/background/tasks/progress.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import type { Color as InkColor } from "@/ink";
import { Box, Text, useRepeatingClock, useTerminalDimensions } from "@/ink";
import type { BackgroundTaskStatus } from "@/kernel/channels/background-tasks.ts";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { ListOverflowIndicator } from "@/ui/chrome/panel.tsx";
import {
  MAX_STATUS_LABEL_WIDTH,
  MIN_STATUS_LABEL_WIDTH,
  statusLabelPadding,
} from "@/ui/chrome/progress/geometry.ts";
import { BULLET_IDLE, BULLET_VIEWED } from "@/ui/chrome/progress/glyphs.ts";
import {
  buildWorkflowRowParts,
  isTerminalWorkflowStatus,
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
  statusText: string;
  queuedText: string;
}

function RunningAgentsPanelImpl({
  agents,
  workflows,
  selection,
  focusInPanel,
  viewingAgentId,
  mainLlmBusy,
}: RunningAgentsPanelProps): React.JSX.Element | null {
  const now = useLiveNow(hasLiveRows(agents, workflows));
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
  const agentWindow = computeListWindow({
    cursor: selectedAgentIdx,
    total: totalAgents,
    size: agentRows,
    anchor: "edge",
    previousStart: agentWindowStartRef.current,
  });
  agentWindowStartRef.current = agentWindow.from;

  const visibleAgents = agents.slice(agentWindow.from, agentWindow.to);
  const agentMoreUpCount = agentWindow.above;
  const agentMoreDownCount = agentWindow.below;

  const totalWorkflows = workflows.length;
  const selectedWorkflowIdx = selection?.namespace === "workflows" ? selection.index : -1;
  const workflowWindow = computeListWindow({
    cursor: selectedWorkflowIdx,
    total: totalWorkflows,
    size: workflowRows,
    anchor: "edge",
    previousStart: workflowWindowStartRef.current,
  });
  workflowWindowStartRef.current = workflowWindow.from;
  const visibleWorkflowParts = workflowParts.slice(workflowWindow.from, workflowWindow.to);
  const workflowMoreUpCount = workflowWindow.above;
  const workflowMoreDownCount = workflowWindow.below;

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
        const actualIndex = agentWindow.from + i;
        // Nested rows keep their gutter on every page; when the parent row
        // scrolled above the window the branch renders as a continuation (├,
        // never the closing └) so the tree reads as carried over the fold.
        let connectorContinuation = false;
        if (task.depth && task.depth > 1) {
          for (let j = actualIndex - 1; j >= 0; j--) {
            if ((agents[j]?.depth ?? 1) < task.depth) {
              connectorContinuation = j < agentWindow.from;
              break;
            }
          }
        }
        const connector = connectorContinuation
          ? "  ".repeat(Math.max(0, (task.depth ?? 2) - 2)) + "├ "
          : agentConnector(task);
        const status = buildAgentStatus(task, now);
        return (
          <PanelAgentLine
            key={`agent-${task.id}`}
            agentName={task.agentName}
            description={task.description ?? ""}
            taskStatus={task.status}
            connector={connector}
            hiddenCountSuffix={hiddenSuffix(task)}
            labelWidth={labelWidth}
            statusText={status.statusText}
            queuedText={status.queuedText}
            highlighted={focusInPanel && agentIdx === actualIndex + 1}
            viewed={viewingAgentId === task.id}
          />
        );
      })}
      {agentMoreDownCount > 0 && <PanelMoreLine direction="down" count={agentMoreDownCount} />}
      {workflowMoreUpCount > 0 && <PanelMoreLine direction="up" count={workflowMoreUpCount} />}
      {visibleWorkflowParts.map((parts, i) => {
        const actualIndex = workflowWindow.from + i;
        return (
          <PanelWorkflowLine
            key={`workflow-${workflows[actualIndex]?.id ?? actualIndex}`}
            name={parts.name}
            description={parts.description}
            statusText={parts.statusText}
            bulletColor={parts.bulletColor}
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

const PanelMainLine = memo(function PanelMainLine({
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
});

function PanelMoreLine({
  direction,
  count,
}: {
  direction: "up" | "down";
  count: number;
}): React.JSX.Element {
  return (
    <Box justifyContent="flex-end">
      <ListOverflowIndicator direction={direction} count={count} />
    </Box>
  );
}

// Rows receive only primitive props (strings, booleans, numbers, theme color
// constants) so React.memo's shallow compare actually holds: the background
// store clones every task on each emit, and passing the task object would give
// every row a fresh identity four times per second.
const PanelAgentLine = memo(function PanelAgentLine({
  agentName,
  description,
  taskStatus,
  connector,
  hiddenCountSuffix,
  labelWidth,
  statusText,
  queuedText,
  highlighted,
  viewed,
}: {
  agentName: string;
  description: string;
  taskStatus: BackgroundTaskStatus;
  connector: string;
  hiddenCountSuffix: string;
  labelWidth: number;
  statusText: string;
  queuedText: string;
  highlighted: boolean;
  viewed: boolean;
}): React.JSX.Element {
  const dim = !highlighted && !viewed;
  const prefix = highlighted ? Glyph.chevron : "  ";
  const bullet = viewed ? BULLET_VIEWED : BULLET_IDLE;

  let bulletColor: InkColor | undefined;
  if (taskStatus === "completed") {
    bulletColor = Color.success;
  } else if (taskStatus === "error" || taskStatus === "killed") {
    bulletColor = Color.error;
  } else {
    bulletColor = dim ? Color.muted : Color.text;
  }

  const adjustedLabelWidth = Math.max(1, labelWidth - stringWidth(connector));
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
          {agentName}
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
        <Text>
          <Text color={Color.muted}>{statusText}</Text>
          {queuedText.length > 0 && <Text color={Color.warning}>{` · ${queuedText}`}</Text>}
        </Text>
      </Box>
    </Box>
  );
});

const PanelWorkflowLine = memo(function PanelWorkflowLine({
  name,
  description,
  statusText,
  bulletColor,
  labelWidth,
  selected,
}: {
  name: string;
  description: string;
  statusText: string;
  bulletColor: InkColor | undefined;
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
        {bulletColor !== undefined ? (
          <Text color={bulletColor}>{`${BULLET_IDLE} `}</Text>
        ) : (
          <Text color={Color.muted}>{`${BULLET_IDLE} `}</Text>
        )}
      </Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={dim ? Color.muted : Color.text} wrap="truncate">
          {name}
        </Text>
      </Box>
      <Box flexGrow={1} width={0} paddingLeft={2}>
        <Text color={Color.muted} wrap="truncate">
          {description}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} justifyContent="flex-end">
        <Text color={Color.muted}>{statusText}</Text>
      </Box>
    </Box>
  );
});

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
  const endRef = isRunning ? now : (task.endedAt ?? task.startedAt);
  const elapsed = formatDuration(Math.max(0, endRef - task.startedAt));

  // Panel counters cover the whole descendant subtree so a depth-1 row keeps
  // moving while only grandchildren do tool work. Merge the row prop over the
  // store so fixture-only tests (no live store entries) still show tokens.
  const byId = new Map(listBackgroundTasks().map((entry) => [entry.id, entry]));
  byId.set(task.id, task);
  const progress = aggregateSubtreeProgress(task.id, [...byId.values()]);
  const arrow = isRunning ? "↓" : "↑";
  const parts: string[] = [elapsed];
  if (progress.tokenCount > 0) {
    parts.push(`${arrow} ${formatTokens(progress.tokenCount)} tokens`);
  }
  if (progress.toolUses > 0) {
    parts.push(`${progress.toolUses} tool${progress.toolUses === 1 ? "" : "s"}`);
  }

  const queuedCount =
    isRunning && task.forkId !== undefined ? pendingAgentSteerCount(task.forkId) : 0;

  return {
    statusText: parts.join(" · "),
    queuedText: queuedCount > 0 ? `${queuedCount} queued` : "",
  };
}

function hasLiveRows(agents: BackgroundTask[], workflows: LocalWorkflowTaskState[]): boolean {
  return (
    agents.some((t) => t.status === "running") ||
    workflows.some((t) => !isTerminalWorkflowStatus(t.status))
  );
}

const LIVE_TICK_INTERVAL_MS = 1000;

// One shared clock for every row: `now` is held in state and only advances on
// the once-per-second tick. Renders caused by token/store updates reuse the
// held value, so a row's displayed seconds can never shift because another
// row's data changed between ticks.
function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useRepeatingClock(() => setNow(Date.now()), active ? LIVE_TICK_INTERVAL_MS : null, {
    immediate: true,
  });
  return now;
}

export const RunningAgentsPanel = memo(RunningAgentsPanelImpl);
