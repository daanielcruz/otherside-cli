import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type WorkflowTaskStatus = "running" | "paused" | "completed" | "failed" | "killed";

export type WorkflowAgentControlReason = "user-skip" | "user-retry";
export type WorkflowAgentAttemptReason = "throttled";

export interface WorkflowPhaseSpec {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export interface AgentTranscriptToolUseEntry {
  name: string;
  summary: string;
}

export interface AgentTranscript {
  agentId: string;
  prompt: string;
  toolCalls: AgentTranscriptToolUseEntry[];
  finalText: string;
}

export interface WorkflowAgentStatus {
  type: "workflow_agent";
  index: number;
  label: string;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: WorkflowAgentAttemptReason;
  cached?: boolean;
  skipped?: boolean;
  state: "start" | "done" | "error";
  /** When the agent joined the queue. Set for every agent, waiting or not. */
  queuedAt?: number;
  /** When a slot freed and work began. Absent while the agent is still waiting. */
  startedAt?: number;
  lastProgressAt: number;
  tokens?: number;
  toolCalls?: number;
  transcript?: AgentTranscript;
  promptPreview?: string;
  resultPreview?: string;
  lastToolName?: string;
  lastToolSummary?: string;
}

export interface WorkflowPhaseStatus {
  type: "workflow_phase";
  index: number;
  title: string;
  kind?: string;
}

export interface WorkflowLogProgress {
  type: "workflow_log";
  message: string;
}

export type WorkflowProgressItem = WorkflowAgentStatus | WorkflowPhaseStatus | WorkflowLogProgress;

export interface WorkflowTaskSnapshot {
  id: string;
  type: "local_workflow";
  status: WorkflowTaskStatus;
  parentToolCallId: string;
  workflowRunId: string;
  cwd: string;
  sessionId: string;
  provider?: ProviderId;
  model?: string;
  workflowName: string;
  title?: string;
  description: string;
  script?: string;
  scriptPath?: string;
  args?: unknown;
  summary?: string;
  phases?: WorkflowPhaseSpec[];
  workflowProgress: WorkflowProgressItem[];
  progressVersion: number;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];
  degradedRouting?: string[];
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
  outputFile?: string;
  abortController: AbortController;
  agentControllers?: Map<string, AbortController>;
  ownerId?: string;
  stoppedByUser?: boolean;
}

export interface WorkflowTasksProvider {
  list(): WorkflowTaskSnapshot[];
  subscribe(fn: () => void): () => void;
}

let provider: WorkflowTasksProvider | null = null;

export function registerWorkflowTasksProvider(impl: WorkflowTasksProvider): void {
  provider = impl;
}

function requireWorkflowTasksProvider(): WorkflowTasksProvider {
  if (provider === null) {
    throw new Error("Workflow task provider is not registered");
  }
  return provider;
}

export function listWorkflowTasks(): WorkflowTaskSnapshot[] {
  return requireWorkflowTasksProvider().list();
}

export function subscribeWorkflowTasks(fn: () => void): () => void {
  return requireWorkflowTasksProvider().subscribe(fn);
}

export function _resetWorkflowTasksProviderForTests(): void {
  provider = null;
}
