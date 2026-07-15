import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export type WorkflowTaskStatus = "running" | "paused" | "completed" | "failed" | "killed";

export type WorkflowAgentControlReason = "user-skip" | "user-retry";

export interface WorkflowPhaseDescriptor {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export interface AgentTranscriptToolCall {
  name: string;
  summary: string;
}

export interface AgentTranscript {
  agentId: string;
  prompt: string;
  toolCalls: AgentTranscriptToolCall[];
  finalText: string;
}

export interface WorkflowAgentProgress {
  type: "workflow_agent";
  index: number;
  label: string;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: "throttled" | "stalled";
  cached?: boolean;
  skipped?: boolean;
  state: "start" | "done" | "error";
  startedAt: number;
  lastProgressAt: number;
  tokens?: number;
  toolCalls?: number;
  transcript?: AgentTranscript;
  promptPreview?: string;
  resultPreview?: string;
  lastToolName?: string;
  lastToolSummary?: string;
}

export interface WorkflowPhaseProgress {
  type: "workflow_phase";
  index: number;
  title: string;
  kind?: string;
}

export interface WorkflowLogProgress {
  type: "workflow_log";
  message: string;
}

export type WorkflowProgressEntry =
  | WorkflowAgentProgress
  | WorkflowPhaseProgress
  | WorkflowLogProgress;

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
  phases?: WorkflowPhaseDescriptor[];
  workflowProgress: WorkflowProgressEntry[];
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
