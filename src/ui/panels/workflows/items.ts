import type { WorkflowSnapshot } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import {
  buildMergedPhases,
  type MergedPhase,
} from "@/engine/background/workflows/runtime/progress/merge.ts";
import type {
  WorkflowAgentStatus,
  WorkflowProgressItem,
  WorkflowTaskLifecycle,
  WorkflowTaskStatus,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { wrapText } from "@/terminal-runtime/text/plain-wrap.ts";
import { type AgentDisplayStatus, CROSS, PAUSE_GLYPH, TICK } from "@/ui/chrome/progress/glyphs.ts";

/**
 * One workflow as the panel shows it, whether it is still running in this session or
 * was read back from disk. Both sources collapse to this shape so every view below
 * reads one record and never asks where it came from.
 */
export interface WorkflowListItem {
  id: string;
  runId: string;
  name: string;
  description: string;
  status: WorkflowTaskStatus;
  agentCount: number;
  totalTokens: number;
  durationMs: number;
  startTime: number;
  script: string;
  scriptPath?: string;
  args?: unknown;
  phases: WorkflowPhaseSpec[];
  workflowProgress: WorkflowProgressItem[];
  live: boolean;
}

export const NAME_MAX_CHARS = 50;
export const META_SEPARATOR = " · ";
/** A running agent only earns an idle badge once the silence is long enough to mean something. */
export const IDLE_BADGE_MIN_SECONDS = 30;
export const PROMPT_PREVIEW_MAX_LINES = 2;
const SPINNER_GLYPH = "⟳";
/** Width the expandable-prompt test wraps at, independent of the rendered column. */
const PROMPT_EXPANDABLE_PROBE_WIDTH = 40;

/** Live runs win over their own disk snapshot; newest first. */
export function mergeItems(
  liveTasks: WorkflowTaskLifecycle[],
  history: WorkflowSnapshot[],
): WorkflowListItem[] {
  const liveRunIds = new Set(liveTasks.map((task) => task.workflowRunId));
  const items: WorkflowListItem[] = liveTasks.map(liveItem);
  for (const snapshot of history) {
    if (liveRunIds.has(snapshot.workflowRunId ?? snapshot.runId)) continue;
    items.push(snapshotItem(snapshot));
  }
  return items.sort((left, right) => right.startTime - left.startTime);
}

export function liveItem(task: WorkflowTaskLifecycle): WorkflowListItem {
  return {
    id: task.id,
    runId: task.workflowRunId,
    name: task.title ?? task.workflowName,
    description: task.description,
    status: task.status,
    agentCount: task.agentCount,
    totalTokens: task.totalTokens,
    durationMs: (task.endedAt ?? Date.now()) - task.startedAt,
    startTime: task.startedAt,
    script: task.script ?? "",
    ...(task.scriptPath !== undefined ? { scriptPath: task.scriptPath } : {}),
    args: task.args,
    phases: task.phases ?? [],
    workflowProgress: task.workflowProgress,
    live: true,
  };
}

export function snapshotItem(snapshot: WorkflowSnapshot): WorkflowListItem {
  return {
    id: snapshot.taskId,
    runId: snapshot.workflowRunId ?? snapshot.runId,
    name: snapshot.title ?? snapshot.workflowName ?? snapshot.summary ?? snapshot.runId,
    description: snapshot.summary ?? "",
    status: snapshot.status,
    agentCount: snapshot.agentCount,
    totalTokens: snapshot.totalTokens,
    durationMs: snapshot.durationMs,
    startTime: snapshot.startTime,
    script: snapshot.script,
    ...(snapshot.scriptPath !== undefined ? { scriptPath: snapshot.scriptPath } : {}),
    args: snapshot.args,
    phases: snapshot.phases ?? [],
    workflowProgress: snapshot.workflowProgress,
    live: false,
  };
}

export function mergedPhases(item: WorkflowListItem): MergedPhase[] {
  return buildMergedPhases({
    workflowProgress: item.workflowProgress,
    phases: item.phases,
  });
}

export function subtitleText(items: WorkflowListItem[]): string {
  const runningCount = items.filter((item) => item.status === "running").length;
  const completedCount = items.length - runningCount;
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (completedCount > 0) parts.push(`${completedCount} completed`);
  return parts.join(META_SEPARATOR);
}

export function statusGlyph(status: WorkflowTaskStatus): string {
  if (status === "completed") return TICK;
  if (status === "failed" || status === "killed") return CROSS;
  if (status === "paused") return PAUSE_GLYPH;
  return SPINNER_GLYPH;
}

export function phaseGlyph(status: MergedPhase["status"], index: number): string {
  if (status === "done") return TICK;
  if (status === "failed") return CROSS;
  return String(index + 1);
}

export function rowMeta(item: WorkflowListItem): string {
  const parts: string[] = [];
  if (item.agentCount > 0) {
    parts.push(`${item.agentCount} agent${item.agentCount === 1 ? "" : "s"}`);
  }
  if (item.totalTokens > 0) parts.push(`${formatTokens(item.totalTokens)} tok`);
  parts.push(formatDuration(item.durationMs));
  return parts.join(META_SEPARATOR);
}

export function truncateName(name: string): string {
  if (name.length <= NAME_MAX_CHARS) return name;
  return `${name.slice(0, NAME_MAX_CHARS - 1)}…`;
}

/** An agent whose workflow has stopped reads as interrupted, whatever it was doing. */
export function agentStatusLabel(input: {
  agent: WorkflowAgentStatus;
  workflowActive: boolean;
}): AgentDisplayStatus {
  const { agent, workflowActive } = input;
  if (agent.skipped) return "skipped";
  if (agent.state === "done") return "done";
  if (agent.state === "error" && agent.stopped) return "interrupted";
  if (agent.state === "error") return "failed";
  if (!workflowActive) return "interrupted";
  // No start time means no slot was ever granted: the agent is waiting, not working.
  return agent.startedAt === undefined ? "queued" : "running";
}

/** Seconds a running agent has gone without progress; null when that is not the question. */
export function agentIdleSeconds(
  agent: WorkflowAgentStatus,
  status: AgentDisplayStatus,
  now: number,
): number | null {
  if (status !== "running") return null;
  const seconds = Math.floor((now - agent.lastProgressAt) / 1000);
  return seconds >= IDLE_BADGE_MIN_SECONDS ? seconds : null;
}

export function agentRowMeta(
  agent: WorkflowAgentStatus,
  status: AgentDisplayStatus,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (agent.model) parts.push(agent.model);
  if (agent.tokens != null) parts.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls != null && agent.toolCalls > 0) {
    parts.push(`${agent.toolCalls} ${pluralize(agent.toolCalls, "tool")}`);
  }
  const idleSeconds = agentIdleSeconds(agent, status, now);
  if (idleSeconds !== null) parts.push(`idle ${formatDuration(idleSeconds * 1000)}`);
  if (status === "queued") {
    parts.push(
      agent.queuedAt === undefined
        ? "queued"
        : `waiting ${formatDuration(Math.max(0, now - agent.queuedAt))}`,
    );
  }
  if (status === "done" && agent.startedAt !== undefined) {
    parts.push(formatDuration(agent.lastProgressAt - agent.startedAt));
  }
  return parts.length > 0 ? `${META_SEPARATOR}${parts.join(META_SEPARATOR)}` : "";
}

export function isPromptExpandable(agent: WorkflowAgentStatus): boolean {
  const promptText = agent.transcript?.prompt ?? agent.promptPreview ?? "";
  if (promptText.length === 0) return false;
  return wrapText(promptText, PROMPT_EXPANDABLE_PROBE_WIDTH).length > PROMPT_PREVIEW_MAX_LINES;
}
