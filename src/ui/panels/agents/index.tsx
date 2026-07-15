import { useEffect, useState } from "react";
import { list as listAgents, type SubagentDef } from "@/engine/agents/registry.ts";
import {
  type BackgroundTask,
  type BackgroundTaskAction,
} from "@/engine/background/tasks/background.ts";
import { Box, type Color as InkColor, Text, useTerminalDimensions } from "@/ink";
import { FooterPanel, FooterPanelOutputBox } from "@/ui/chrome/panel.tsx";
import { pickerMaxHeight } from "@/ui/chrome/picker-geometry.ts";
import { agentPanelStatus, panelStatusColor } from "@/ui/chrome/progress/glyphs.ts";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useDisposableInterval } from "@/ui/panels/use-disposable-interval";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export const AGENT_LIBRARY_CHROME_ROWS = 12;

export function visibleAgentLibraryRows(terminalRows: number): number {
  return Math.max(1, pickerMaxHeight(terminalRows) - AGENT_LIBRARY_CHROME_ROWS);
}

export function clampAgentLibraryIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

export interface AgentLibraryWindow {
  firstVisible: number;
  lastVisible: number;
  aboveCount: number;
  belowCount: number;
}

export function agentLibraryWindow(
  selected: number,
  count: number,
  visible: number,
): AgentLibraryWindow {
  const visibleRows = Math.max(1, Math.floor(visible));
  const selectedIndex = clampAgentLibraryIndex(selected, count);
  const firstVisible = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleRows / 2), count - visibleRows),
  );
  const lastVisible = Math.min(count, firstVisible + visibleRows);
  return {
    firstVisible,
    lastVisible,
    aboveCount: firstVisible,
    belowCount: count - lastVisible,
  };
}

export function pageAgentLibraryIndex(
  index: number,
  count: number,
  direction: 1 | -1,
  visibleRows: number,
): number {
  return clampAgentLibraryIndex(index + direction * Math.max(1, Math.floor(visibleRows)), count);
}

const AGENT_LIBRARY_SECTIONS = [
  { scope: "user", title: "User" },
  { scope: "project", title: "Project" },
  { scope: "builtin", title: "Built-in" },
] as const;

export function orderedAgentLibrary(agents: readonly SubagentDef[]): SubagentDef[] {
  return AGENT_LIBRARY_SECTIONS.flatMap(({ scope }) =>
    agents.filter((agent) => agent.scope === scope),
  );
}

export interface AgentsOverlayProps {
  onClose?: () => void;
  providerShortKey?: string;
  agents?: SubagentDef[];
}

export function AgentsOverlay({
  onClose,
  providerShortKey = "",
  agents,
}: AgentsOverlayProps = {}): React.JSX.Element {
  const { rows: terminalRows } = useTerminalDimensions();
  const close = useOverlayClose(onClose);
  const library = orderedAgentLibrary(agents ?? listAgents());
  const visibleRows = visibleAgentLibraryRows(terminalRows);
  const libraryKey = library.map((agent) => agent.id).join("\u0000");
  const [selected, setSelected] = useState(0);
  const selectedIndex = clampAgentLibraryIndex(selected, library.length);

  useEffect(() => {
    setSelected((current) => clampAgentLibraryIndex(current, library.length));
  }, [library.length, libraryKey, visibleRows]);

  usePanelNavigation({
    onClose: close,
    rows: { count: library.length, selected: selectedIndex, onChange: setSelected },
    onKey: (_input, key) => {
      if (key.pageUp) {
        setSelected((current) => pageAgentLibraryIndex(current, library.length, -1, visibleRows));
        return true;
      }
      if (key.pageDown) {
        setSelected((current) => pageAgentLibraryIndex(current, library.length, 1, visibleRows));
        return true;
      }
      return false;
    },
  });

  return (
    <AgentLibraryPicker
      agents={library}
      selected={selectedIndex}
      visibleRows={visibleRows}
      providerShortKey={providerShortKey}
    />
  );
}

export function AgentLibraryPicker({
  agents,
  selected,
  visibleRows,
  providerShortKey,
}: {
  agents: readonly SubagentDef[];
  selected: number;
  visibleRows: number;
  providerShortKey: string;
}): React.JSX.Element {
  const selectedIndex = clampAgentLibraryIndex(selected, agents.length);
  const counter = `(${agents.length > 0 ? selectedIndex + 1 : 0} of ${agents.length})`;
  const title = (
    <Box>
      <Text color={Color.primaryGlow} bold>
        Agents
      </Text>
      <Text color={Color.muted}> {counter}</Text>
    </Box>
  );

  return (
    <FooterPanel
      title={title}
      accent={Color.primaryGlow}
      flushTop
      footerHints={[
        ["↑↓", "navigate"],
        ["PgUp/PgDn", "page"],
        ["Esc", "close"],
      ]}
    >
      <LibraryPane
        agents={agents}
        selected={selectedIndex}
        visibleRows={visibleRows}
        providerShortKey={providerShortKey}
      />
    </FooterPanel>
  );
}

export function TaskDetail({ task }: { task: BackgroundTask }): React.JSX.Element {
  const [, setTick] = useState(0);
  useDisposableInterval(
    () => {
      setTick((t) => t + 1);
    },
    1000,
    { active: !task.endedAt },
  );
  const now = Date.now();
  if (task.kind === "shell") return <ShellTaskDetail task={task} />;
  const actions = visibleTaskActions(task);
  const activeActionId = activeTaskActionId(task, actions);
  const displayPrompt =
    task.prompt && task.prompt.length > 300 ? `${task.prompt.substring(0, 297)}…` : task.prompt;
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text color={Color.primaryGlow} bold>
          {`${task.agentName} ${Glyph.chevronThin.trimEnd()} ${task.description ?? "Local agent"}`}
        </Text>
        <TaskSummaryLine task={task} now={now} />
        {task.status === "running" && actions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Progress</Text>
            {actions.map((action) => {
              const active = action.id === activeActionId;
              const lineColor = active ? Color.primaryGlow : Color.muted;
              return (
                <Text key={`${task.id}-a-${action.id}`}>
                  <Text color={lineColor}>{active ? Glyph.chevronThin : "  "}</Text>
                  <Text color={lineColor} bold={active}>
                    {action.toolName}
                  </Text>
                  <Text color={lineColor}>({action.argsLabel})</Text>
                </Text>
              );
            })}
          </Box>
        )}
        {!!displayPrompt && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Prompt</Text>
            <Text color={Color.text}>{displayPrompt}</Text>
          </Box>
        )}
        {task.status === "error" && !!task.result && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={Color.error} bold>
              Error
            </Text>
            <Text color={Color.error}>{task.result.content.slice(0, 400)}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

const SHELL_OUTPUT_TAIL_LINES = 10;
const SHELL_COMMAND_MAX_WIDTH = 280;
const SHELL_DETAIL_HORIZONTAL_PADDING = 6;
const SHELL_DETAIL_BORDER_COLUMNS = 4;

function truncateLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function formatShellRuntime(task: BackgroundTask): string {
  return formatTaskDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

function shellStatusText(task: BackgroundTask): string {
  const exitCode = task.exitCode !== undefined ? ` (exit code: ${task.exitCode})` : "";
  return `${task.status}${exitCode}`;
}

function shellOutputText(task: BackgroundTask): string {
  if (task.status === "running") return task.shellOutput;
  return task.result?.content ?? task.shellOutput;
}

function shellOutputLines(content: string): string[] {
  const starts: number[] = [];
  let pos = content.length;
  for (let i = 0; i < SHELL_OUTPUT_TAIL_LINES && pos > 0; i++) {
    const prev = content.lastIndexOf("\n", pos - 1);
    starts.push(prev + 1);
    pos = prev;
  }
  starts.reverse();
  const rendered: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (start === undefined) continue;
    const nextStart = starts[i + 1];
    const end = nextStart !== undefined ? nextStart - 1 : content.length;
    const line = content.slice(start, end);
    if (line.length > 0) rendered.push(line);
  }
  return rendered;
}

function shellOutputBoxWidth(columns: number): number {
  return Math.max(1, columns - SHELL_DETAIL_HORIZONTAL_PADDING);
}

function ShellTaskDetail({ task }: { task: BackgroundTask }): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  const command = truncateLine(task.command ?? task.description ?? "", SHELL_COMMAND_MAX_WIDTH);
  const outputLines = shellOutputLines(shellOutputText(task)).map((line, i) => ({
    id: `${task.id}-${i}`,
    text: line,
  }));
  const outputBoxWidth = shellOutputBoxWidth(columns);
  const outputLineWidth = Math.max(1, outputBoxWidth - SHELL_DETAIL_BORDER_COLUMNS);
  return (
    <Box flexDirection="column">
      <Text color={Color.primaryGlow} bold>
        Shell details
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text bold>Status:{"  "}</Text>
          <Text color={taskStatusColor(task.status)}>{shellStatusText(task)}</Text>
        </Text>
        <Text>
          <Text bold>Runtime: </Text>
          <Text color={Color.text}>{formatShellRuntime(task)}</Text>
        </Text>
        {command.length > 0 && (
          <Text>
            <Text bold>Command: </Text>
            <Text color={Color.text}>{command}</Text>
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Output:</Text>
        {outputLines.length > 0 ? (
          <Box flexDirection="column">
            <FooterPanelOutputBox height={12} width={outputBoxWidth}>
              {outputLines.map((item) => (
                <Text key={item.id} color={task.result?.isError ? Color.error : Color.text}>
                  {truncateLine(item.text, outputLineWidth)}
                </Text>
              ))}
            </FooterPanelOutputBox>
            <Text color={Color.muted} italic>
              Showing {outputLines.length} lines
            </Text>
          </Box>
        ) : (
          <Text color={Color.muted}>No output available</Text>
        )}
      </Box>
    </Box>
  );
}

function TaskSummaryLine({ task, now }: { task: BackgroundTask; now: number }): React.JSX.Element {
  if (task.status === "running")
    return <Text color={Color.muted}>{formatTaskSummary(task, now)}</Text>;
  return (
    <Text>
      <Text color={taskStatusColor(task.status)}>{taskStatusLabel(task.status)}</Text>
      <Text color={Color.muted}> · {formatTaskSummary(task, now)}</Text>
    </Text>
  );
}

export function visibleTaskActions(task: BackgroundTask, limit = 5): BackgroundTaskAction[] {
  const recent = task.actions.slice(-limit);
  const seen = new Set(recent.map((action) => action.id));
  const running = task.actions.filter((action) => action.running && !seen.has(action.id));
  return [...recent, ...running].sort((a, b) => a.ts - b.ts);
}

function activeTaskActionId(
  task: BackgroundTask,
  actions: BackgroundTaskAction[],
): string | undefined {
  const running = [...actions].reverse().find((action) => action.running);
  if (running) return running.id;
  return task.status === "running" ? actions.at(-1)?.id : undefined;
}

export function LibraryPane({
  agents,
  selected,
  visibleRows,
  providerShortKey,
}: {
  agents: readonly SubagentDef[];
  selected: number;
  visibleRows: number;
  providerShortKey: string;
}): React.JSX.Element {
  if (agents.length === 0) {
    return <Text color={Color.muted}>no subagents registered</Text>;
  }

  const window = agentLibraryWindow(selected, agents.length, visibleRows);
  const visibleAgents = agents.slice(window.firstVisible, window.lastVisible);
  const sections = AGENT_LIBRARY_SECTIONS.map(({ scope, title }) => ({
    title,
    agents: visibleAgents.filter((agent) => agent.scope === scope),
  })).filter((section) => section.agents.length > 0);

  return (
    <Box flexDirection="column">
      {window.aboveCount > 0 && (
        <Box height={1} paddingLeft={2} overflow="hidden">
          <Text color={Color.muted}>↑ {window.aboveCount} more above</Text>
        </Box>
      )}
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column">
          <Box height={1} overflow="hidden">
            <Text color={Color.muted}>{section.title}</Text>
          </Box>
          {section.agents.map((agent) => {
            const index = agents.indexOf(agent);
            const focused = index === selected;
            return (
              <Box key={agent.id} flexDirection="column">
                <Box height={1} width="100%" overflow="hidden">
                  <Text color={focused ? Color.primaryGlow : Color.muted}>
                    {focused ? `${Glyph.triangle} ` : "  "}
                  </Text>
                  <Text color={Color.primaryGlow} bold={focused} wrap="truncate-end">
                    {agent.name}
                  </Text>
                  <Text color={Color.muted} wrap="truncate-end">
                    {` · ${pickModelLabel(agent, providerShortKey)}${agent.background ? " · background" : ""}`}
                  </Text>
                </Box>
                {focused && (
                  <Box height={1} paddingLeft={4} width="100%" overflow="hidden">
                    <Text color={Color.muted} wrap="truncate-end">
                      {agent.description}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
      {window.belowCount > 0 && (
        <Box height={1} paddingLeft={2} overflow="hidden">
          <Text color={Color.muted}>↓ {window.belowCount} more below</Text>
        </Box>
      )}
    </Box>
  );
}

function pickModelLabel(
  agent: { model: Record<string, { model: string }> },
  providerShortKey: string,
): string {
  const active = agent.model[providerShortKey];
  if (active) return active.model;
  const first = Object.values(agent.model)[0];
  return first ? first.model : "inherit";
}

export function formatTaskSummary(task: BackgroundTask, now: number = Date.now()): string {
  const ms = task.endedAt ? task.endedAt - task.startedAt : now - task.startedAt;
  const elapsed = formatTaskDuration(ms);
  if (task.kind === "shell") return `${elapsed} · shell ${task.id}`;
  const tokens = formatTokenCount(task.inputTokens + task.outputTokens);
  return `${elapsed} · ${tokens} tokens · ${formatToolCount(task.actions.length)}`;
}

function formatTaskDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  let seconds = totalSec % 60;
  let minutes = Math.floor(totalSec / 60) % 60;
  let hours = Math.floor(totalSec / 3600) % 24;
  const days = Math.floor(totalSec / 86400);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    hours += 1;
  }
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatToolCount(value: number): string {
  return `${value} tool${value === 1 ? "" : "s"}`;
}

function taskStatusLabel(status: BackgroundTask["status"]): string {
  const panelStatus = agentPanelStatus(status);
  if (!panelStatus) return "Running";
  return panelStatus.charAt(0).toUpperCase() + panelStatus.slice(1);
}

function taskStatusColor(status: BackgroundTask["status"]): InkColor {
  const panelStatus = agentPanelStatus(status);
  return panelStatus ? panelStatusColor(panelStatus) : Color.muted;
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
