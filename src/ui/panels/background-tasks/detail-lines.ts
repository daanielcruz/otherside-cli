import {
  type BackgroundTask,
  type BackgroundTaskAction,
  list as listBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { aggregateSubtreeProgress } from "@/engine/background/tasks/progress.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { agentPanelStatus, panelStatusColor } from "@/ui/chrome/progress/glyphs.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const SHELL_OUTPUT_TAIL_LINES = 10;
const PROMPT_CLIP = 300;
const ERROR_CLIP = 400;
const COMMAND_CLIP = 280;

export function detailFooterHints(
  task: BackgroundTask,
  onForeground?: (task: BackgroundTask) => void,
): [string, string][] {
  const hints: [string, string][] = [
    ["←", "to go back"],
    ["Esc/Enter/Space", "to close"],
  ];
  if (task.kind === "agent" && onForeground) hints.push(["f", "foreground"]);
  if (task.status === "running") hints.push(["x", "to stop"]);
  return hints;
}

export function formatTaskSummary(task: BackgroundTask, now: number = Date.now()): string {
  const ms = task.endedAt ? task.endedAt - task.startedAt : now - task.startedAt;
  const elapsed = formatTaskDuration(ms);
  if (task.kind === "shell") return `${elapsed} · shell ${task.id}`;
  const byId = new Map(listBackgroundTasks().map((entry) => [entry.id, entry]));
  byId.set(task.id, task);
  const progress = aggregateSubtreeProgress(task.id, [...byId.values()]);
  const tokens = formatTokenCount(progress.tokenCount);
  return `${elapsed} · ${tokens} tokens · ${formatToolCount(progress.toolUses)}`;
}

export function formatTaskDuration(ms: number): string {
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

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function taskStatusLabel(status: BackgroundTask["status"]): string {
  const panelStatus = agentPanelStatus(status);
  if (!panelStatus) return "Running";
  return panelStatus.charAt(0).toUpperCase() + panelStatus.slice(1);
}

export function taskStatusColor(status: BackgroundTask["status"]) {
  const panelStatus = agentPanelStatus(status);
  return panelStatus ? panelStatusColor(panelStatus) : Color.muted;
}

export function agentDetailLines(task: BackgroundTask, contentWidth: number): string[] {
  const now = Date.now();
  const allTasks = listBackgroundTasks();
  const actions = visibleSubtreeActions(task, allTasks);
  const activeActionId = activeTaskActionId(task, actions);
  const title = `${task.agentName} ${Glyph.chevronThin.trimEnd()} ${task.description ?? "Local agent"}`;
  const lines: string[] = [
    renderTextWithStyles(cellClip(title, contentWidth), { color: Color.panelAccent, bold: true }),
  ];

  if (task.status === "running") {
    lines.push(renderTextWithStyles(formatTaskSummary(task, now), { color: Color.muted }));
  } else {
    lines.push(
      renderTextWithStyles(taskStatusLabel(task.status), {
        color: taskStatusColor(task.status),
      }) + renderTextWithStyles(` · ${formatTaskSummary(task, now)}`, { color: Color.muted }),
    );
  }

  if (task.status === "running" && actions.length > 0) {
    lines.push("");
    lines.push(renderTextWithStyles("Progress", { bold: true, color: Color.text }));
    for (const action of actions) {
      const active = action.id === activeActionId;
      const lineColor = active ? Color.panelAccent : Color.muted;
      const marker = active ? Glyph.chevronThin : "  ";
      const argsWidth = contentWidth - stringWidth(marker) - stringWidth(action.toolName) - 2;
      lines.push(
        renderTextWithStyles(marker, { color: lineColor }) +
          renderTextWithStyles(action.toolName, { color: lineColor, bold: active }) +
          renderTextWithStyles(`(${cellClip(action.argsLabel, argsWidth)})`, { color: lineColor }),
      );
    }
  }

  if (task.prompt) {
    const display =
      task.prompt.length > PROMPT_CLIP
        ? `${task.prompt.substring(0, PROMPT_CLIP - 3)}…`
        : task.prompt;
    lines.push("");
    lines.push(renderTextWithStyles("Prompt", { bold: true, color: Color.text }));
    for (const line of wrapProse(display, contentWidth)) {
      lines.push(renderTextWithStyles(line, { color: Color.text }));
    }
  }

  if (task.status === "error" && task.result) {
    const err = task.result.content.slice(0, ERROR_CLIP);
    lines.push("");
    lines.push(renderTextWithStyles("Error", { color: Color.error, bold: true }));
    for (const line of wrapProse(err, contentWidth)) {
      lines.push(renderTextWithStyles(line, { color: Color.error }));
    }
  }

  return lines;
}

export function shellDetailLines(task: BackgroundTask, contentWidth: number): string[] {
  const command = (task.command ?? task.description ?? "").slice(0, COMMAND_CLIP);
  const runtime = formatTaskDuration((task.endedAt ?? Date.now()) - task.startedAt);
  const exitCode = task.exitCode !== undefined ? ` (exit code: ${task.exitCode})` : "";
  const statusText = `${task.status}${exitCode}`;
  const output =
    task.status === "running" ? task.shellOutput : (task.result?.content ?? task.shellOutput);
  const outputLines = shellOutputLines(output);
  const lines: string[] = [
    renderTextWithStyles("Shell details", { color: Color.panelAccent, bold: true }),
    "",
    renderTextWithStyles("Status:  ", { bold: true, color: Color.text }) +
      renderTextWithStyles(statusText, { color: taskStatusColor(task.status) }),
    renderTextWithStyles("Runtime: ", { bold: true, color: Color.text }) +
      renderTextWithStyles(runtime, { color: Color.text }),
  ];
  if (command.length > 0) {
    // Wrapped inside the value column (see cellClip's row-width law);
    // continuations align under the value.
    const label = "Command: ";
    const valueWidth = Math.max(1, contentWidth - label.length);
    const [first = "", ...rest] = wrapProse(command, valueWidth);
    lines.push(
      renderTextWithStyles(label, { bold: true, color: Color.text }) +
        renderTextWithStyles(first, { color: Color.text }),
    );
    for (const row of rest) {
      lines.push(" ".repeat(label.length) + renderTextWithStyles(row, { color: Color.text }));
    }
  }
  lines.push("");
  lines.push(renderTextWithStyles("Output:", { bold: true, color: Color.text }));
  if (outputLines.length === 0) {
    lines.push(renderTextWithStyles("No output available", { color: Color.muted }));
  } else {
    const color = task.result?.isError ? Color.error : Color.text;
    for (const line of outputLines) {
      lines.push(renderTextWithStyles(cellClip(line, contentWidth), { color }));
    }
    lines.push(
      renderTextWithStyles(`Showing ${outputLines.length} lines`, {
        color: Color.muted,
        italic: true,
      }),
    );
  }
  return lines;
}

function shellOutputLines(content: string): string[] {
  if (!content) return [];
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

function visibleSubtreeActions(
  task: BackgroundTask,
  allTasks: readonly BackgroundTask[],
  limit = 5,
): BackgroundTaskAction[] {
  const actions: BackgroundTaskAction[] = [];
  const pending = [task.id];
  const seenIds = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seenIds.has(id)) continue;
    seenIds.add(id);
    const current = allTasks.find((candidate) => candidate.id === id);
    if (!current) continue;
    actions.push(...current.actions);
    for (const child of allTasks) {
      if (child.parentTaskId === id) pending.push(child.id);
    }
  }
  return selectVisibleActions(actions, limit);
}

function selectVisibleActions(
  actions: readonly BackgroundTaskAction[],
  limit: number,
): BackgroundTaskAction[] {
  const recent = actions.slice(-limit);
  const seen = new Set(recent.map((action) => action.id));
  const running = actions.filter((action) => action.running && !seen.has(action.id));
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
