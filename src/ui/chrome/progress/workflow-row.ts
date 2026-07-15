import { buildMergedPhases } from "@/engine/background/workflows/runtime/progress/merge.ts";
import { computeWorkflowProgress } from "@/engine/background/workflows/runtime/store/progress.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import type { Color as InkColor } from "@/ink";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { Color } from "@/ui/theme/theme.ts";

export interface WorkflowRowParts {
  name: string;
  description: string;
  statusText: string;
  bulletColor: InkColor | undefined;
  stateVerb: string | undefined;
  stateColor: InkColor | undefined;
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function workflowBulletColor(status: string, failedCount: number): InkColor | undefined {
  if (isTerminalWorkflowStatus(status)) {
    return status === "completed" ? Color.success : Color.error;
  }
  if (failedCount > 0) return Color.error;
  if (status === "paused") return Color.warning;
  return undefined;
}

function getCurrentPhaseTitle(task: LocalWorkflowTaskState): string {
  const phases = buildMergedPhases({
    workflowProgress: task.workflowProgress,
    ...(task.phases !== undefined ? { phases: task.phases } : {}),
  });
  if (phases.length === 0) return "";
  const running = phases.find((p) => p.status === "running");
  if (running) return running.title;
  const done = [...phases].reverse().find((p) => p.status === "done");
  if (done) return done.title;
  return phases[0]?.title ?? "";
}

function summarizeDescription(rawDescription: string, name: string): string {
  const head = rawDescription.includes(":")
    ? rawDescription.slice(0, rawDescription.indexOf(":"))
    : rawDescription;
  const trimmed = head.trim();
  return trimmed === name ? "" : trimmed;
}

export function buildWorkflowRowParts(task: LocalWorkflowTaskState, now: number): WorkflowRowParts {
  const progress = computeWorkflowProgress(task.workflowProgress, task.agentCount);
  const endRef = isTerminalWorkflowStatus(task.status) ? (task.endedAt ?? task.startedAt) : now;
  const elapsedMs = Math.max(0, endRef - task.startedAt);

  const phase = getCurrentPhaseTitle(task);
  const agentsText = progress.total > 0 ? `${progress.done}/${progress.total} agents` : "";
  const failedText = progress.failedCount > 0 ? `${progress.failedCount} failed` : "";
  const elapsed = formatDuration(elapsedMs);
  const tokenText = task.totalTokens > 0 ? `↓ ${formatTokens(task.totalTokens)} tokens` : "";

  const parts = [phase, agentsText, failedText, elapsed, tokenText].filter(Boolean);

  return {
    name: task.workflowName,
    description: summarizeDescription(task.description, task.workflowName),
    statusText: parts.join(" · "),
    bulletColor: workflowBulletColor(task.status, progress.failedCount),
    stateVerb: undefined,
    stateColor: undefined,
  };
}
