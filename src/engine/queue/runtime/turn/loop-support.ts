import { listRunning as bgListRunning } from "@/engine/background/tasks/background.ts";
import { listWorkflowTasks } from "@/engine/background/workflows/runtime/store/store.ts";
import type { CompactOrchestrationDeps } from "@/engine/queue/runtime/compact/orchestration.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { TurnLoopHost } from "./types.ts";

/** Live background work owned by the session — what a goal pause waits on. */
export function runningSessionWorkCount(sessionId: string): number {
  const backgroundTasks = bgListRunning().filter((task) => task.sessionId === sessionId).length;
  const workflows = listWorkflowTasks().filter(
    (task) => task.sessionId === sessionId && task.status === "running",
  ).length;
  return backgroundTasks + workflows;
}

export function compactDepsFor(host: TurnLoopHost): CompactOrchestrationDeps {
  return {
    agentDeps: host.deps,
    state: host.compactState,
    turnId: host.currentTurnId,
    activeAbortController: () => host.activeAbortController,
    setActiveAbortController: (ctrl) => {
      host.activeAbortController = ctrl;
    },
    injections: host.injections,
    makeCtx: () => makeRequestContext(host.deps, host.currentTurnId ?? undefined),
    clearNestedMemory: () => {
      host.loadedNestedMemoryPaths.clear();
      host.nestedMemoryByPath.clear();
    },
  };
}
