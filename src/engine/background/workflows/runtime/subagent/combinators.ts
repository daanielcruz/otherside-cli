import { toSandboxError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import {
  WORKFLOW_MAX_PARALLEL_ITEMS,
  type WorkflowSubagentBridgeOptions,
} from "./bridge-contract.ts";
import type { CacheExecutionScope, WorkflowCacheReplay } from "./cache-replay.ts";

export interface WorkflowCombinators {
  runParallel: (thunks: unknown) => Promise<unknown[]>;
  runPipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>;
}

export function createWorkflowCombinators(
  options: WorkflowSubagentBridgeOptions,
  cacheReplay: WorkflowCacheReplay,
): WorkflowCombinators {
  const runParallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw toSandboxError("parallel() requires an array of functions.");
    }
    if (thunks.length > WORKFLOW_MAX_PARALLEL_ITEMS) {
      throw toSandboxError(
        `parallel() accepts at most ${WORKFLOW_MAX_PARALLEL_ITEMS} items; got ${thunks.length}.`,
      );
    }
    // Validate every slot before dispatching any of them — a non-function
    // entry (e.g. a Promise passed instead of a `() => agent(...)` thunk) is
    // an authoring bug and must fail loudly, not silently resolve to null.
    thunks.forEach((thunk, index) => {
      if (typeof thunk !== "function") {
        throw toSandboxError(
          new TypeError(
            `parallel() expects an array of functions; slot ${index} is ${typeof thunk}.`,
          ),
        );
      }
    });
    return cacheReplay.runBatch(
      "parallel",
      `items:${thunks.length}`,
      thunks as (() => unknown)[],
      async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          options.recordFailure?.(`parallel[${index}]: ${errorMessage(error)}`);
          return null;
        }
      },
    );
  };

  const runPipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw toSandboxError("pipeline() requires an array of items.");
    }
    if (items.length > WORKFLOW_MAX_PARALLEL_ITEMS) {
      throw toSandboxError(
        `pipeline() accepts at most ${WORKFLOW_MAX_PARALLEL_ITEMS} items; got ${items.length}.`,
      );
    }
    // Validate every stage before running any item — an invalid stage arg is
    // an authoring bug, caught at call time rather than skipped per item.
    stages.forEach((stage, index) => {
      if (typeof stage !== "function") {
        throw toSandboxError(
          new TypeError(
            `pipeline() expects a function for each stage; stage ${index} is ${typeof stage}.`,
          ),
        );
      }
    });
    return cacheReplay.runBatch(
      "pipeline",
      `items:${items.length}:stages:${stages.length}`,
      items,
      async (item, index) => {
        let value: unknown = item;
        const itemScope = cacheReplay.activeScope();
        const typedStages = stages as ((prev: unknown, item: unknown, index: number) => unknown)[];
        for (const [stageIndex, stage] of typedStages.entries()) {
          // A null value short-circuits the rest of this item's chain — the
          // remaining stages are skipped and the item's result is null. Other
          // items are unaffected (each runs its own independent chain).
          if (value === null) break;
          const stageScope: CacheExecutionScope = {
            path: `${itemScope.path}/stage:${stageIndex}`,
            chain: itemScope.chain,
            operationIndex: 0,
          };
          try {
            value = await cacheReplay.runInScope(stageScope, () => stage(value, item, index));
          } catch (error) {
            options.recordFailure?.(`pipeline[${index}]: ${errorMessage(error)}`);
            return null;
          }
        }
        return value;
      },
    );
  };

  return { runParallel, runPipeline };
}
