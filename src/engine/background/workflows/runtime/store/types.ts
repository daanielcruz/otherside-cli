import type { WorkflowPhaseDescriptor } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { AgentTranscript } from "@/engine/background/workflows/runtime/transcript/types.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";

export type WorkflowAgentControlReason = "user-skip" | "user-retry";

export const WORKFLOW_AGENT_SKIP_REASON: WorkflowAgentControlReason = "user-skip";
export const WORKFLOW_AGENT_RETRY_REASON: WorkflowAgentControlReason = "user-retry";

export type WorkflowProgressEntry =
  | WorkflowAgentProgress
  | WorkflowPhaseProgress
  | WorkflowLogProgress;

export interface WorkflowAgentProgress {
  type: "workflow_agent";
  index: number;
  label: string;
  phaseTitle?: string;
  agentId?: string;
  // Resolved routing provider of the stage agent (model is display-only);
  // feeds the allocation scope for passive quota warnings.
  provider?: ProviderId;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: "throttled" | "stalled";
  cached?: boolean;
  skipped?: boolean;
  stopped?: boolean;
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

export interface LocalWorkflowTaskState {
  id: string;
  type: "local_workflow";
  status: WorkflowTaskStatus;
  parentToolCallId: string;
  workflowRunId: string;
  cwd: string;
  sessionId: string;
  // Parent session provider/model at launch — workflow agents inherit the
  // provider; used to roll the run's token usage into the ledger at completion.
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
  /** Per-agent failure lines collected during the run (model-facing). */
  failures?: string[];
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
