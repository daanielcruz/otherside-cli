import type { SubagentResult } from "@/engine/background/subagents/dispatcher.ts";
import { WORKFLOW_DEFAULT_STALL_MS } from "@/engine/background/subagents/fork/constants.ts";
import type { Worktree } from "@/engine/background/subagents/worktree.ts";
import { toSandboxError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import type { WorkflowAgentAttemptReason } from "@/engine/background/workflows/runtime/store/types.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const WORKFLOW_THROTTLE_BACKOFF_MS = 45000;
const WORKFLOW_THROTTLE_MIN_OUTPUT_TOKENS = 50;
const WORKFLOW_THROTTLE_DURATION_FRACTION = 0.5;

export interface WorkflowForkRequest {
  ctx: RequestContext;
  name: string;
  body: string;
  allowSet: Set<string> | null;
  extraDeclarations: ProviderToolDeclaration[];
  prompt: string;
  parentToolCallId: string;
  agentId: string;
  outputSchema?: Record<string, unknown> | undefined;
  sink?: ForkEventSink | undefined;
  isolation?: "worktree" | undefined;
  worktreeKey?: string | undefined;
  // Owner-managed worktree, created once and reused across the throttle retry so
  // the physical snapshot is not rebuilt from potentially drifted source.
  worktree?: Worktree | undefined;
}

export type WorkflowForkRunner = (request: WorkflowForkRequest) => Promise<SubagentResult>;

export type WorkflowBackoffSleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultBackoffSleep: WorkflowBackoffSleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(toSandboxError("Workflow was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toSandboxError("Workflow was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

let backoffSleepOverride: WorkflowBackoffSleep | null = null;

export function setWorkflowBackoffSleepForTests(sleep: WorkflowBackoffSleep | null): void {
  backoffSleepOverride = sleep;
}

function isThrottledResult(result: SubagentResult): boolean {
  if (result.isError) return false;
  if (result.structured !== undefined) return false;
  const outputTokens = result.outputTokens ?? Number.POSITIVE_INFINITY;
  if (outputTokens >= WORKFLOW_THROTTLE_MIN_OUTPUT_TOKENS) return false;
  const durationMs = result.durationMs ?? 0;
  return durationMs > WORKFLOW_DEFAULT_STALL_MS * WORKFLOW_THROTTLE_DURATION_FRACTION;
}

export async function runForkWithRetries(
  runFork: WorkflowForkRunner,
  request: WorkflowForkRequest,
  signal: AbortSignal,
): Promise<{
  result: SubagentResult;
  attempt: number;
  lastAttemptReason?: WorkflowAgentAttemptReason;
}> {
  const result = await runFork(request);
  if (!isThrottledResult(result)) return { result, attempt: 1 };

  const sleep = backoffSleepOverride ?? defaultBackoffSleep;
  await sleep(WORKFLOW_THROTTLE_BACKOFF_MS, signal);
  return {
    result: await runFork(request),
    attempt: 2,
    lastAttemptReason: "throttled",
  };
}
