import {
  getWorkflowTask,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowProgressItem } from "@/engine/background/workflows/runtime/store/types.ts";
import type { WorkflowAgentEvent } from "@/engine/background/workflows/runtime/subagent/bridge.ts";

export function recordWorkflowLog(taskId: string, message: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  updateWorkflowTask(taskId, {
    logs: [...task.logs, message],
    progressVersion: task.progressVersion + 1,
  });
}

export function recordWorkflowFailure(taskId: string, message: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  updateWorkflowTask(taskId, {
    failures: [...(task.failures ?? []), message],
    logs: [...task.logs, `failure: ${message}`],
    progressVersion: task.progressVersion + 1,
  });
}

export function recordWorkflowAgentEvent(taskId: string, event: WorkflowAgentEvent): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  const now = Date.now();
  const existingIndex = task.workflowProgress.findIndex(
    (entry) => entry.type === "workflow_agent" && entry.index === event.index,
  );
  const existing = existingIndex >= 0 ? task.workflowProgress[existingIndex] : undefined;
  const prior = existing !== undefined && existing.type === "workflow_agent" ? existing : undefined;
  const queuedAt = prior?.queuedAt ?? now;
  // The clock starts when a slot frees, not when the agent was created: a waiting
  // agent keeps no start time, so its row reads as queued and its elapsed figure
  // never counts time it spent doing nothing.
  const startedAt = event.queued === true ? prior?.startedAt : (prior?.startedAt ?? now);
  const existingTokens =
    existing !== undefined && existing.type === "workflow_agent" ? existing.tokens : undefined;
  const nextTokens = event.tokens ?? existingTokens;
  const toolCallCount = event.transcript?.toolCalls.length;
  const entry: WorkflowProgressItem = {
    type: "workflow_agent",
    index: event.index,
    label: event.label,
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...(event.phaseTitle !== undefined ? { phaseTitle: event.phaseTitle } : {}),
    ...(event.route !== undefined ? { route: event.route } : {}),
    ...(event.provider !== undefined ? { provider: event.provider } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
    state: event.state,
    queuedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    lastProgressAt: now,
    ...(event.transcript !== undefined ? { transcript: event.transcript } : {}),
    ...(toolCallCount !== undefined ? { toolCalls: toolCallCount } : {}),
    ...(nextTokens !== undefined ? { tokens: nextTokens } : {}),
    ...(event.prompt !== undefined ? { promptPreview: event.prompt } : {}),
    ...(event.resultPreview !== undefined ? { resultPreview: event.resultPreview } : {}),
    ...(event.lastToolName !== undefined ? { lastToolName: event.lastToolName } : {}),
    ...(event.lastToolSummary !== undefined ? { lastToolSummary: event.lastToolSummary } : {}),
    ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
    ...(event.cached === true ? { cached: true } : {}),
    ...(event.skipped === true ? { skipped: true } : {}),
    ...(event.stopped === true ? { stopped: true } : {}),
    ...(event.isolation !== undefined ? { isolation: event.isolation } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.lastAttemptReason !== undefined
      ? { lastAttemptReason: event.lastAttemptReason }
      : {}),
  };
  const nextProgress =
    existingIndex >= 0
      ? task.workflowProgress.map((current, position) =>
          position === existingIndex ? entry : current,
        )
      : [...task.workflowProgress, entry];
  const totalToolCalls = nextProgress.reduce(
    (sum, current) => (current.type === "workflow_agent" ? sum + (current.toolCalls ?? 0) : sum),
    0,
  );
  updateWorkflowTask(taskId, {
    workflowProgress: nextProgress,
    progressVersion: task.progressVersion + 1,
    totalToolCalls,
    ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
    ...(existingIndex < 0 ? { agentCount: task.agentCount + 1 } : {}),
  });
}

export function recordWorkflowPhase(taskId: string, title: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  const phase = task.phases?.find((candidate) => candidate.title === title);
  const index =
    phase?.index ?? task.workflowProgress.filter((entry) => entry.type === "workflow_phase").length;
  const entry: WorkflowProgressItem = {
    type: "workflow_phase",
    index,
    title,
  };
  updateWorkflowTask(taskId, {
    workflowProgress: [...task.workflowProgress, entry],
    progressVersion: task.progressVersion + 1,
  });
}
