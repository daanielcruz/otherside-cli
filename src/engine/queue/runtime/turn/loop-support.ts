import type { CompactOrchestrationDeps } from "@/engine/queue/runtime/compact/orchestration.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { TurnLoopHost } from "./types.ts";

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
