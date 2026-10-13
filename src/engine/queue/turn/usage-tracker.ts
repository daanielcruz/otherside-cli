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
  type TokenTotals,
} from "@/engine/session/usage/provider.ts";
import { type ContextUsageSnapshot, contextUsageTotal } from "@/engine/session/usage/snapshot.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { MessageUsageSnapshot } from "@/kernel/std/types/message.ts";
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
    event: Partial<ContextUsageSnapshot>,
  ) => ContextUsageSnapshot;
  setProgressInputTokens: SetState<number>;
  setLiveOutputTokens: (tokens: number) => void;
}

export interface TurnUsageTracker {
  applyToProgress: (ev: AgentEvent) => void;
  applyUsageEvent: (ev: Partial<MessageUsageSnapshot>) => void;
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
  let lastUsageSnapshot: TokenTotals & ContextUsageSnapshot = emptyTokenTotals();
  let pendingContextUpdate = false;
  let pendingContextStamp = false;
  let pendingUsage = emptyTokenTotals();
  let requestCounted = false;
  let stampedUsage = emptyTokenTotals();
  let requestStamped = false;

  const flushUsage = (): void => {
    const hasSpend = hasTokenUsage(pendingUsage);
    if (!hasSpend && !pendingContextUpdate) return;
    recordProviderUsage(
      turnState.provider,
      turnState.model,
      pendingUsage.inputTokens,
      pendingUsage.outputTokens,
      pendingUsage.thoughtTokens,
      pendingUsage.cacheCreationInputTokens,
      pendingUsage.cacheReadInputTokens,
      { countRequest: !requestCounted && hasSpend, contextUsage: lastUsageSnapshot },
    );
    if (hasSpend) requestCounted = true;
    pendingUsage = emptyTokenTotals();
    pendingContextUpdate = false;
  };

  const takeRequestUsageStamp = (): AssistantRequestUsage | null => {
    const uncommitted = positiveTokenDelta(stampedUsage, lastUsageSnapshot);
    const hasSpend = hasTokenUsage(uncommitted);
    if (!hasSpend && !pendingContextStamp) return null;
    const stamp: AssistantRequestUsage = {
      ...(lastUsageSnapshot.contextTokens !== undefined
        ? { contextTokens: lastUsageSnapshot.contextTokens }
        : {}),
      input_tokens: uncommitted.inputTokens,
      output_tokens: uncommitted.outputTokens,
      thought_tokens: uncommitted.thoughtTokens,
      cache_creation_input_tokens: uncommitted.cacheCreationInputTokens,
      cache_read_input_tokens: uncommitted.cacheReadInputTokens,
      request_count: requestStamped || !hasSpend ? 0 : 1,
    };
    if (hasSpend) requestStamped = true;
    stampedUsage = {
      inputTokens: lastUsageSnapshot.inputTokens,
      outputTokens: lastUsageSnapshot.outputTokens,
      thoughtTokens: lastUsageSnapshot.thoughtTokens,
      cacheCreationInputTokens: lastUsageSnapshot.cacheCreationInputTokens,
      cacheReadInputTokens: lastUsageSnapshot.cacheReadInputTokens,
    };
    pendingContextStamp = false;
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
    lastUsageSnapshot = nextUsageSnapshot;
    if (ev.contextTokens !== undefined) {
      pendingContextUpdate = true;
      pendingContextStamp = true;
    }
    sawUsageEvent = true;
    if ((contextUsageTotal(usageDelta) ?? 0) > 0 || pendingContextUpdate) flushUsage();
  };

  const resetForMessageStart = (): void => {
    flushUsage();
    const straggler = takeRequestUsageStamp();
    if (straggler) void appendUsageOnlyAssistantRecord(straggler).catch(() => {});
    lastUsageSnapshot = emptyTokenTotals();
    pendingContextUpdate = false;
    pendingContextStamp = false;
    pendingUsage = emptyTokenTotals();
    requestCounted = false;
    stampedUsage = emptyTokenTotals();
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
