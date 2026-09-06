import {
  applyAgentEventToProgress,
  emptyProgressState,
  progressTokensDown,
} from "@/engine/queue/turn/progress.ts";
import {
  type AssistantRequestUsage,
  appendRecord,
  nowIso,
  type Session,
} from "@/engine/session/index.ts";
import {
  addTokenTotals,
  emptyTokenTotals,
  hasTokenUsage,
  positiveTokenDelta,
} from "@/engine/session/usage/provider.ts";
import { type ContextUsageSnapshot, contextUsageTotal } from "@/engine/session/usage/snapshot.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

type SetState<T> = (value: T | ((prev: T) => T)) => void;
type BrokerState = ReturnType<BrokerHandle["read"]>;

export interface TurnUsageTrackerDeps {
  session: Session;
  turnState: BrokerState;
  recordProviderUsage: (
    provider: ProviderId,
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    thoughtTokens?: number,
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number,
    options?: {
      countRequest?: boolean;
      estimated?: boolean;
      isFork?: boolean;
      contextUsage?: ContextUsageSnapshot;
    },
  ) => void;
  mergeContextUsageSnapshot: (
    previous: ContextUsageSnapshot,
    event: {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      cacheCreationInputTokens?: number | undefined;
      cacheReadInputTokens?: number | undefined;
    },
  ) => ContextUsageSnapshot;
  setProgressInputTokens: SetState<number>;
  setLiveOutputTokens: (tokens: number) => void;
}

export interface TurnUsageTracker {
  applyToProgress: (ev: AgentEvent) => void;
  applyUsageEvent: (ev: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  }) => void;
  flushUsage: () => void;
  flushTurnEnd: () => void;
  takeRequestUsageStamp: () => AssistantRequestUsage | null;
  appendUsageOnlyAssistantRecord: (usage: AssistantRequestUsage) => Promise<void>;
  resetForMessageStart: () => void;
  snapshot: () => {
    sawUsageEvent: boolean;
    progressState: ReturnType<typeof emptyProgressState>;
  };
}

export function createTurnUsageTracker(deps: TurnUsageTrackerDeps): TurnUsageTracker {
  const {
    session,
    turnState,
    recordProviderUsage,
    mergeContextUsageSnapshot,
    setProgressInputTokens,
    setLiveOutputTokens,
  } = deps;

  let progressState = emptyProgressState();
  let sawUsageEvent = false;
  let lastUsageSnapshot = emptyTokenTotals();
  let pendingUsage = emptyTokenTotals();
  let requestCounted = false;
  let requestUsage = emptyTokenTotals();
  let requestStamped = false;

  const flushUsage = (): void => {
    if (!hasTokenUsage(pendingUsage)) return;
    recordProviderUsage(
      turnState.provider,
      turnState.model,
      pendingUsage.inputTokens,
      pendingUsage.outputTokens,
      pendingUsage.thoughtTokens,
      pendingUsage.cacheCreationInputTokens,
      pendingUsage.cacheReadInputTokens,
      { countRequest: !requestCounted, contextUsage: lastUsageSnapshot },
    );
    requestCounted = true;
    pendingUsage = emptyTokenTotals();
  };

  const takeRequestUsageStamp = (): AssistantRequestUsage | null => {
    if (!hasTokenUsage(requestUsage)) return null;
    const stamp: AssistantRequestUsage = {
      input_tokens: requestUsage.inputTokens,
      output_tokens: requestUsage.outputTokens,
      thought_tokens: requestUsage.thoughtTokens,
      cache_creation_input_tokens: requestUsage.cacheCreationInputTokens,
      cache_read_input_tokens: requestUsage.cacheReadInputTokens,
      request_count: requestStamped ? 0 : 1,
    };
    requestStamped = true;
    requestUsage = emptyTokenTotals();
    return stamp;
  };

  const appendUsageOnlyAssistantRecord = (usage: AssistantRequestUsage): Promise<void> =>
    appendRecord(session, {
      type: "assistant_message",
      ts: nowIso(),
      content: "",
      usage,
      provider: turnState.provider,
      model: turnState.model,
    });

  const flushTurnEnd = (): void => {
    flushUsage();
    const usage = takeRequestUsageStamp();
    if (usage) void appendUsageOnlyAssistantRecord(usage).catch(() => {});
  };

  const applyToProgress = (ev: AgentEvent): void => {
    const next = applyAgentEventToProgress(progressState, ev);
    if (next === progressState) return;
    progressState = next;
    setLiveOutputTokens(progressTokensDown(progressState));
  };

  const applyUsageEvent: TurnUsageTracker["applyUsageEvent"] = (ev) => {
    const nextUsageSnapshot = {
      ...mergeContextUsageSnapshot(lastUsageSnapshot, ev),
      thoughtTokens: ev.thoughtTokens ?? lastUsageSnapshot.thoughtTokens,
    };
    const usageDelta = positiveTokenDelta(lastUsageSnapshot, nextUsageSnapshot);
    setProgressInputTokens((prev) => prev + usageDelta.inputTokens);
    pendingUsage = addTokenTotals(pendingUsage, usageDelta);
    requestUsage = addTokenTotals(requestUsage, usageDelta);
    lastUsageSnapshot = nextUsageSnapshot;
    sawUsageEvent = true;
    if (contextUsageTotal(usageDelta) > 0) flushUsage();
  };

  const resetForMessageStart = (): void => {
    flushUsage();
    const straggler = takeRequestUsageStamp();
    if (straggler) void appendUsageOnlyAssistantRecord(straggler).catch(() => {});
    lastUsageSnapshot = emptyTokenTotals();
    pendingUsage = emptyTokenTotals();
    requestCounted = false;
    requestUsage = emptyTokenTotals();
    requestStamped = false;
  };

  return {
    applyToProgress,
    applyUsageEvent,
    flushUsage,
    flushTurnEnd,
    takeRequestUsageStamp,
    appendUsageOnlyAssistantRecord,
    resetForMessageStart,
    snapshot: () => ({ sawUsageEvent, progressState }),
  };
}
