import { registerMainAgent } from "@/engine/agents/inbox.ts";
import {
  type CompactOrchestrationDeps,
  type CompactState,
  type ForceCompactOptions,
  type ForceCompactResult,
  forceCompact as forceCompactImpl,
} from "@/engine/queue/runtime/compact/orchestration.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { runTurn as runTurnImpl, type TurnLoopHost } from "@/engine/queue/runtime/turn/loop.ts";
import type { AgentDeps } from "@/engine/queue/runtime/turn/types.ts";
import {
  canonicalizeWorkingDirectory,
  readCliWorkingDirectories,
} from "@/engine/queue/runtime/working-directories.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import { appendRecord, nowIso } from "@/engine/session/index.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { AgentEvent, DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export type { AgentDeps } from "@/engine/queue/runtime/turn/types.ts";

export class Agent {
  readonly injections = makeQueue();
  readonly sessionAllowedToolPatterns = new Set<string>();
  cancelled = false;
  currentTurnId: string | null = null;
  activeAbortController: AbortController | null = null;
  readonly activeToolAbortControllers = new Set<AbortController>();
  readonly loadedNestedMemoryPaths = new Set<string>();
  readonly nestedMemoryByPath = new Map<string, string>();
  pendingUserInputDrainer: (() => DrainedQueuedMessage[]) | null = null;
  compactState: CompactState = {
    rapidRefillBreakerOpen: false,
    rapidRefillCount: 0,
    consecutiveCompactFailures: 0,
    turnsSinceLast: Number.POSITIVE_INFINITY,
    lastAutoCompactAttemptTurnId: null,
  };

  constructor(readonly deps: AgentDeps) {
    for (const directory of deps.config.permissions?.additionalDirectories ?? []) {
      const canonical = canonicalizeWorkingDirectory(directory, deps.session.cwd);
      if (canonical !== null) deps.session.additionalWorkingDirectories.add(canonical);
    }
    for (const directory of readCliWorkingDirectories(deps.session.cwd)) {
      deps.session.additionalWorkingDirectories.add(directory);
    }
    registerMainAgent(deps.session.id);
  }

  pushInjection(text: string): void {
    this.injections.push(text);
    appendRecord(this.deps.session, {
      type: "injection_queued",
      ts: nowIso(),
      text,
      source: "system",
    }).catch(() => {});
  }

  pushInjectionInMemoryOnly(text: string): void {
    this.injections.push(text);
  }

  setPendingUserInputDrainer(fn: (() => DrainedQueuedMessage[]) | null): void {
    this.pendingUserInputDrainer = fn;
  }

  resetSessionScopedPermissions(): void {
    this.sessionAllowedToolPatterns.clear();
  }

  resetMicrocompactState(): void {
    this.compactState = {
      rapidRefillBreakerOpen: false,
      rapidRefillCount: 0,
      consecutiveCompactFailures: 0,
      turnsSinceLast: Number.POSITIVE_INFINITY,
      lastAutoCompactAttemptTurnId: null,
    };
    clearLastUsage();
  }

  updateConfig(config: UserConfig): void {
    this.deps.config = config;
  }

  cancel(): void {
    this.cancelled = true;
    this.activeAbortController?.abort("user-cancel");
    for (const controller of this.activeToolAbortControllers) {
      controller.abort("user-cancel");
    }
  }

  forceCompact(opts?: ForceCompactOptions): Promise<ForceCompactResult> {
    return forceCompactImpl(this.compactDeps(), opts);
  }

  async *runTurn(
    userInput: string | ContentBlock[],
    keywordText?: string,
  ): AsyncIterable<AgentEvent> {
    yield* runTurnImpl(this as TurnLoopHost, userInput, keywordText);
  }

  getNestedMemorySnapshot(): { path: string; content: string }[] {
    return [...this.nestedMemoryByPath.entries()].map(([path, content]) => ({ path, content }));
  }

  private compactDeps(): CompactOrchestrationDeps {
    return {
      agentDeps: this.deps,
      state: this.compactState,
      turnId: this.currentTurnId,
      activeAbortController: () => this.activeAbortController,
      setActiveAbortController: (ctrl) => {
        this.activeAbortController = ctrl;
      },
      injections: this.injections,
      makeCtx: () => makeRequestContext(this.deps, this.currentTurnId ?? undefined),
      clearNestedMemory: () => {
        this.loadedNestedMemoryPaths.clear();
        this.nestedMemoryByPath.clear();
      },
    };
  }
}

export {
  buildPostCompactRehydration,
  collectImageBlocks,
} from "@/engine/session/compact/rehydration.ts";
export { estimateTokens } from "@/engine/session/compact/token-count.ts";
