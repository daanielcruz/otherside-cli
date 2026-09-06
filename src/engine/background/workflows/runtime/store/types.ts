import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import type { AgentTranscript } from "@/engine/background/workflows/runtime/transcript/types.ts";
import type {
  WorkflowAgentAttemptReason,
  WorkflowTaskStatus,
} from "@/kernel/channels/workflow-tasks.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export type {
  WorkflowAgentAttemptReason,
  WorkflowTaskStatus,
} from "@/kernel/channels/workflow-tasks.ts";

export type WorkflowAgentControlReason = "user-skip" | "user-retry";

export const WORKFLOW_AGENT_SKIP_REASON: WorkflowAgentControlReason = "user-skip";
export const WORKFLOW_AGENT_RETRY_REASON: WorkflowAgentControlReason = "user-retry";

export type WorkflowProgressItem = WorkflowAgentStatus | WorkflowPhaseStatus | WorkflowLogProgress;

export interface WorkflowAgentStatus {
  type: "workflow_agent";
  index: number;
  label: string;
  phaseTitle?: string;
  agentId?: string;
  /** Atomic routing identity (model id, not display name). Prefer this for allocation. */
  route?: ProviderModelRoute;
  // Legacy dual fields: provider is the routing provider; model is display-only
  // for UI rows. Mirrored from `route` when the route is known.
  provider?: ProviderId;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: WorkflowAgentAttemptReason;
  cached?: boolean;
  skipped?: boolean;
  stopped?: boolean;
  state: "start" | "done" | "error";
  /** When the agent joined the queue. Set for every agent, waiting or not. */
  queuedAt?: number;
  /**
   * When a concurrency slot freed and the agent began work. Absent while it is
   * still waiting, which is what separates a queued row from a running one.
   */
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

export interface WorkflowTaskLifecycle {
  id: string;
  type: "local_workflow";
  status: WorkflowTaskStatus;
  parentToolCallId: string;
  workflowRunId: string;
  cwd: string;
  sessionId: string;
  /** Parent session route at launch — agents inherit provider; ledger uses both. */
  route?: ProviderModelRoute;
  // Legacy dual fields mirrored from `route` for readers that still split them.
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
