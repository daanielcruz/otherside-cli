import type {
  WorkflowBudgetState,
  WorkflowTokenMeter,
} from "@/engine/background/workflows/runtime/budget/budget.ts";
import type {
  WorkflowDispatchRecord,
  WorkflowOutputRecord,
  WorkflowRunRecord,
} from "@/engine/background/workflows/runtime/history/run-ledger.ts";
import type { WorkflowAgentAttemptReason } from "@/engine/background/workflows/runtime/store/types.ts";
import type { AgentTranscript } from "@/engine/background/workflows/runtime/transcript/types.ts";
import type { ModelFallbackDeviation } from "@/engine/model/facts/model-fallback-decision.ts";
import type { TierResolution } from "@/engine/model/tier/resolver.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { WorkflowForkRunner } from "./fork-retries.ts";

export const WORKFLOW_MAX_AGENTS = 1000;
export const WORKFLOW_MAX_PARALLEL_ITEMS = 4096;

export interface WorkflowAgentEvent {
  index: number;
  label: string;
  phaseTitle?: string;
  /** Atomic routing identity (model id). Prefer this for allocation. */
  route?: { provider: ProviderId; model: string };
  // Resolved routing provider — allocation falls back here when route is absent.
  // `model` remains the display name for UI rows outside this package.
  provider?: ProviderId;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: WorkflowAgentAttemptReason;
  state: "start" | "done" | "error";
  /**
   * The agent is created but still waiting on a concurrency slot. It has no work
   * in flight yet, so the row must not read as running.
   */
  queued?: boolean;
  cached?: boolean;
  skipped?: boolean;
  stopped?: boolean;
  agentId?: string;
  prompt?: string;
  transcript?: AgentTranscript;
  resultPreview?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  tokens?: number;
  totalTokens?: number;
}

export interface WorkflowSubagentBridgeOptions {
  ctx: RequestContext;
  parentToolCallId: string;
  runId: string;
  signal: AbortSignal;
  onAgentEvent?: (event: WorkflowAgentEvent) => void;
  onAgentController?: (agentId: string, controller: AbortController | null) => void;
  recordFailure?: (message: string) => void;
  /** Progress/log channel for non-failure notices (e.g. resume respawns). */
  log?: (message: string) => void;
  getCurrentPhase?: () => string | undefined;
  runFork?: WorkflowForkRunner;
  meter?: WorkflowTokenMeter;
  budget?: WorkflowBudgetState;
  runLog?: {
    persistRecord: (record: WorkflowRunRecord) => Promise<void>;
    outputsByCacheKey: Map<string, WorkflowOutputRecord>;
    dispatchesByCacheKey: Map<string, WorkflowDispatchRecord[]>;
  };
}

export interface WorkflowSubagentBridge {
  agent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  parallel: (thunks: unknown) => Promise<unknown[]>;
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>;
  agentCount: () => number;
}

export interface WorkflowAgentModelContextDetail {
  ok: boolean;
  ctx: RequestContext;
  error?: string;
  degradedReasons?: string[];
  fallbackDeviation?: ModelFallbackDeviation;
  /** The resolved tier pool (top-1 or top-3), so the run can pin it across agents. */
  selectedPool?: TierResolution[];
}
