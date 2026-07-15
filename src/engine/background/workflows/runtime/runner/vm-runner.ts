import type { Script } from "node:vm";
import {
  buildWorkflowVmContext,
  type WorkflowVmContextOptions,
} from "@/engine/background/workflows/runtime/runner/context.ts";
import { cloneWorkflowBoundaryResult } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import {
  buildVmSafeError,
  shortErrorStack,
} from "@/engine/background/workflows/runtime/sandbox/errors.ts";

const WORKFLOW_VM_SYNC_TIMEOUT_MS = 30_000;
const WORKFLOW_LOG_LIMIT = 1000;
const WORKFLOW_LOG_CAP_MESSAGE = `\u2026log capped at ${WORKFLOW_LOG_LIMIT} lines`;

export interface WorkflowVmRunResult {
  result?: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

export async function runWorkflowVm(
  vmScript: Script,
  options: WorkflowVmContextOptions = {},
): Promise<WorkflowVmRunResult> {
  const startedAt = Date.now();
  const logs: string[] = [];
  const context = buildWorkflowVmContext({
    ...options,
    hooks: {
      ...options.hooks,
      log: (message) => {
        if (logs.length < WORKFLOW_LOG_LIMIT - 1) logs.push(message);
        else if (logs.length === WORKFLOW_LOG_LIMIT - 1) logs.push(WORKFLOW_LOG_CAP_MESSAGE);
        options.hooks?.log?.(message);
      },
    },
  });
  try {
    if (options.signal?.aborted) throw buildVmSafeError("Workflow aborted.");
    const completion = Promise.resolve(
      vmScript.runInContext(context.context, { timeout: WORKFLOW_VM_SYNC_TIMEOUT_MS }),
    );
    const result = await raceWorkflowAbort(completion, options.signal);
    const cloned = cloneWorkflowBoundaryResult(result);
    if (cloned.hasFunction) {
      throw buildVmSafeError("workflow returned a function; return plain data");
    }
    return {
      result: cloned.value,
      logs,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      logs,
      durationMs: Date.now() - startedAt,
      error: shortErrorStack(error),
    };
  }
}

function raceWorkflowAbort(completion: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  completion.catch(() => {});
  if (!signal) return completion;
  let detach = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(buildVmSafeError("Workflow aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    detach = (): void => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([completion, aborted]).finally(detach);
}
