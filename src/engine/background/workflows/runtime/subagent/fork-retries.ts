import type { SubagentResult } from "@/engine/background/subagents/dispatcher.ts";
import { WORKFLOW_DEFAULT_STALL_MS } from "@/engine/background/subagents/fork/constants.ts";
import type { Worktree } from "@/engine/background/subagents/worktree.ts";
import { buildVmSafeError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const WORKFLOW_MAX_STALL_RETRIES = 5;
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
  // Owner-managed worktree, created once and reused across every retry so the
  // physical snapshot survives throttle/stall attempts instead of being rebuilt.
  worktree?: Worktree | undefined;
}

export type WorkflowForkRunner = (request: WorkflowForkRequest) => Promise<SubagentResult>;

export type WorkflowBackoffSleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultBackoffSleep: WorkflowBackoffSleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(buildVmSafeError("Workflow was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(buildVmSafeError("Workflow was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

let backoffSleepOverride: WorkflowBackoffSleep | null = null;

export function setWorkflowBackoffSleepForTests(sleep: WorkflowBackoffSleep | null): void {
  backoffSleepOverride = sleep;
}

function isThrottledResult(result: SubagentResult): boolean {
  if (result.stalled === true || result.isError) return false;
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
  lastAttemptReason?: "throttled" | "stalled";
}> {
  const sleep = backoffSleepOverride ?? defaultBackoffSleep;
  let result = await runFork(request);
  let attempt = 1;
  let lastAttemptReason: "throttled" | "stalled" | undefined;

  const throttled = isThrottledResult(result);
  if (throttled) {
    await sleep(WORKFLOW_THROTTLE_BACKOFF_MS, signal);
    result = await runFork(request);
    attempt += 1;
    lastAttemptReason = "throttled";
  }

  for (
    let stall = 1;
    result.stalled === true && !throttled && stall <= WORKFLOW_MAX_STALL_RETRIES;
    stall++
  ) {
    if (signal.aborted) throw buildVmSafeError("Workflow was aborted.");
    result = await runFork(request);
    attempt += 1;
    lastAttemptReason = "stalled";
  }

  return lastAttemptReason !== undefined
    ? { result, attempt, lastAttemptReason }
    : { result, attempt };
}
