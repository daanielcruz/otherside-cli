import type { Agent } from "@/engine/queue/index.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import type { TurnLifecycle } from "@/engine/queue/runtime/turn/lifecycle.ts";
import type { createClearTranscript } from "@/engine/session/clear-transcript.ts";
import type { Session } from "@/engine/session/index.ts";
import type { RecordProviderUsageFn } from "@/engine/session/usage/record-provider-usage.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { ErrorActionId, ErrorMeta } from "@/engine/transport/error-meta.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { AutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { MutableRef, StateSetter } from "@/kernel/std/types/state.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { AgentTranscriptHelpers } from "@/ui/app/agent-transcript.ts";
import type { createApplySlashResult } from "@/ui/app/dispatch/slash-result.ts";
import type { createPendingInputDrainer } from "@/ui/app/drain/pending-input-drainer.ts";
import type { createPostTurnDrain } from "@/ui/app/drain/post-turn.ts";
import type { UsageSetters } from "@/ui/app/usage-setters.ts";
import type { TranscriptSetters } from "@/ui/transcript/stream/setters.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface DispatchLoopDeps {
  session: Session;
  broker: Broker;
  agent: Agent;
  version: string;
  exit: (error?: Error) => void;
  runtimeConfig: UserConfig;
  transcript: readonly TranscriptEntry[];
  mainLastContext: ContextUsageSnapshot;
  turnGuard: TurnGuard;
  turnLifecycle: TurnLifecycle;
  autoResumeDispatch: AutoClearDispatch;
  getBgTasksOpen: () => boolean;
  clearTranscript: ReturnType<typeof createClearTranscript>;
  applySlashResult: ReturnType<typeof createApplySlashResult>;
  runBtwTurn: (question: string) => Promise<void>;
  enterBtwMode: (question: string) => void;
  recordProviderUsage: RecordProviderUsageFn;
  slashLifecycle: { onSessionFinalize: (handler: () => void | Promise<void>) => void };
  pushQueued: (text: string) => void;
  pendingInputDrainer: ReturnType<typeof createPendingInputDrainer>;
  postTurnDrain: ReturnType<typeof createPostTurnDrain>;
  agentBlockText: AgentTranscriptHelpers["agentBlockText"];
  setAgentNested: AgentTranscriptHelpers["setAgentNested"];
  setAgentBackgrounded: AgentTranscriptHelpers["setAgentBackgrounded"];
  beginThinkingStatus: () => void;
  endThinkingStatus: () => void;
  resetThinkingStatus: () => void;
  transcriptBatch: MacrotaskBatch;
  setTranscript: TranscriptSetters["setTranscript"];
  setStreamingId: TranscriptSetters["setStreamingId"];
  setStreamingText: TranscriptSetters["setStreamingText"];
  setStreamingThinking: TranscriptSetters["setStreamingThinking"];
  setStreamingCommittedLen: TranscriptSetters["setStreamingCommittedLen"];
  setCodexUsage: UsageSetters["setCodexUsage"];
  setMainTokenTotals: UsageSetters["setMainTokenTotals"];
  setMainLastContext: UsageSetters["setMainLastContext"];
  setProgressInputTokens: StateSetter<number>;
  setProgressStartedAt: StateSetter<number | null>;
  setTasksExpanded: StateSetter<boolean>;
  setContextWarningSuppressed: StateSetter<boolean>;
  setConfigInitialTab: (tab: "details" | "config" | undefined) => void;
  setLoginInitialProvider: StateSetter<ProviderId | undefined>;
  showErrorPanel: (meta: ErrorMeta) => void;
  handleQuotaExhausted: (resetEpochMs: number | null) => void;
  showUnsupportedImageInput: (providerId: ProviderId) => void;
  flushDeferredPersistence: () => Promise<void>;
  clearExitPending: () => void;
  promptHistoryIndexRef: MutableRef<number | null>;
  pasteStoreRef: MutableRef<PasteStore>;
}

export interface DispatchLoop {
  onSubmit: (text: string) => Promise<void>;
  runSubmittedTurn: (
    text: string,
    opts?: {
      suppressUserTranscript?: boolean;
      additionalContext?: string[];
      blocks?: ContentBlock[];
      isRemote?: boolean;
      restoreEntryId?: string;
    },
  ) => Promise<void>;
  handleErrorAction: (id: ErrorActionId) => void;
  requestBackgroundResume: () => void;
}
