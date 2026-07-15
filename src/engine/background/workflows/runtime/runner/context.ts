import { createContext, runInContext } from "node:vm";
import type { WorkflowBudgetState } from "@/engine/background/workflows/runtime/budget/budget.ts";
import { createWorkflowVmBoundaryClone } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import {
  buildVmSafeError,
  wrapSyncForVm,
} from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import { applyWorkflowSandbox } from "@/engine/background/workflows/runtime/sandbox/harden.ts";
import {
  createAbortableTimers,
  type WorkflowAbortableTimers,
} from "@/engine/background/workflows/runtime/sandbox/timers.ts";

export interface WorkflowVmHooks {
  log?: (message: string) => void;
  phase?: (title: string) => void;
  agent?: (prompt: string, options?: unknown) => Promise<unknown>;
  parallel?: (items: unknown) => Promise<unknown>;
  pipeline?: (...items: unknown[]) => Promise<unknown>;
  workflow?: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
}

export interface WorkflowVmContextOptions {
  args?: unknown;
  signal?: AbortSignal;
  hooks?: WorkflowVmHooks;
  budget?: WorkflowBudgetState;
}

export interface WorkflowVmContextResult {
  context: object;
  timers: WorkflowAbortableTimers;
}

function wrapAsyncForVm<Args extends unknown[]>(
  fn: (...args: Args) => Promise<unknown>,
  cloneIntoVm: (value: unknown) => unknown,
): (...args: Args) => Promise<unknown> {
  const wrapped = async (...args: Args) => {
    // Args are already VM-owned; parallel/pipeline pass functions that must not
    // be cloned. Results cross the other direction and must be reified in the
    // VM realm instead of exposing host objects or JSON-round-tripping values.
    try {
      const result = await fn(...args);
      return result !== undefined && result !== null && typeof result === "object"
        ? cloneIntoVm(result)
        : result;
    } catch (error) {
      throw buildVmSafeError(error);
    }
  };
  Object.setPrototypeOf(wrapped, null);
  return wrapped;
}

export function buildWorkflowVmContext(
  options: WorkflowVmContextOptions = {},
): WorkflowVmContextResult {
  const hooks = options.hooks ?? {};
  const timers = createAbortableTimers(options.signal, (message) => hooks.log?.(message));
  const context = createContext(buildContextGlobals({ hooks, timers }), {
    codeGeneration: { strings: false, wasm: false },
  });
  applyWorkflowSandbox(context);

  const cloneIntoVm = createWorkflowVmBoundaryClone(context);
  const makeVmRecord = runInContext(
    "values => Object.assign(Object.create(null), values)",
    context,
  ) as (values: Record<string, unknown>) => Record<string, unknown>;
  Object.defineProperty(context, "args", {
    value: options.args === undefined ? undefined : cloneIntoVm(options.args),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(context, "budget", {
    value: makeVmRecord(buildBudget(options.budget)),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(context, "console", {
    value: makeVmRecord(buildConsole(hooks)),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  timers.bindVMInvoke((callback) => runInContext("fn => fn()", context)(callback));
  const toVmAsync = runInContext("hostFn => async (...a) => hostFn(...a)", context) as (
    hostFn: unknown,
  ) => unknown;
  for (const name of ["agent", "parallel", "pipeline", "workflow"] as const) {
    const hook = hooks[name] ?? missingAsyncHook(name);
    Object.defineProperty(context, name, {
      value: toVmAsync(
        wrapAsyncForVm(hook as (...args: unknown[]) => Promise<unknown>, cloneIntoVm),
      ),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { context, timers };
}

function buildContextGlobals(input: {
  hooks: WorkflowVmHooks;
  timers: WorkflowAbortableTimers;
}): Record<string, unknown> {
  return {
    __proto__: null,
    args: undefined,
    budget: null,
    log: wrapSyncForVm((message: string) => input.hooks.log?.(String(message))),
    phase: wrapSyncForVm((title: string) => input.hooks.phase?.(String(title))),
    agent: undefined,
    parallel: undefined,
    pipeline: undefined,
    workflow: undefined,
    console: null,
    setTimeout: input.timers.setTimeout,
    clearTimeout: input.timers.clearTimeout,
  };
}

function buildBudget(budget?: WorkflowBudgetState): Record<string, unknown> {
  if (!budget) {
    return {
      total: null,
      spent: wrapSyncForVm(() => 0),
      remaining: wrapSyncForVm(() => Number.POSITIVE_INFINITY),
    };
  }
  return {
    total: budget.total,
    spent: wrapSyncForVm(() => budget.spent()),
    remaining: wrapSyncForVm(() => budget.remaining()),
  };
}

function buildConsole(hooks: WorkflowVmHooks): Record<string, unknown> {
  return {
    log: wrapSyncForVm((...items: unknown[]) => hooks.log?.(items.map(String).join(" "))),
    error: wrapSyncForVm((...items: unknown[]) => hooks.log?.(items.map(String).join(" "))),
    warn: wrapSyncForVm((...items: unknown[]) => hooks.log?.(items.map(String).join(" "))),
  };
}

function missingAsyncHook(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} is not available in this workflow runtime yet.`);
  };
}
