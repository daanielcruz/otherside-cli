import { type MutableRefObject, type SetStateAction, useMemo } from "react";
import type { PendingChange, SlashResult } from "@/commands/index.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { RecordProviderUsageFn } from "@/engine/session/usage/record-provider-usage.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { btwAbortRef, btwSeqRef, btwSessionIdRef } from "@/store/btw-store/run.ts";
import { runningRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import {
  agentModelByCallIdRef,
  forkToCallIdRef,
  nextTranscriptId,
  routeForkEventRef,
} from "@/store/turn-tracking/index.ts";
import {
  type AgentTranscriptHelpers,
  createAgentTranscriptHelpers,
} from "@/ui/app/agent-transcript.ts";
import { type BtwController, createBtwController } from "@/ui/app/controllers/btw.ts";
import { createForkEventRouter } from "@/ui/app/dispatch/fork-event-router.ts";
import { createApplySlashResult, createRecordPanelCommit } from "@/ui/app/dispatch/slash-result.ts";
import { createPendingInputDrainer } from "@/ui/app/drain/pending-input-drainer.ts";
import { createPostTurnDrain } from "@/ui/app/drain/post-turn.ts";
import {
  createPromptHistoryNav,
  type PromptHistoryNav,
} from "@/ui/app/drain/prompt-history-nav.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

type SetTranscript = (value: SetStateAction<readonly TranscriptEntry[]>) => void;
type RunSkill = (name: string, args: string, raw: string) => void | Promise<void>;
type ApplySlashResult = (result: SlashResult, text: string) => Promise<void>;
type RecordPanelCommit = (commandName: string, feedback: string) => void;

interface TurnWiringDeps {
  session: Session;
  broker: Broker;
  agent: Agent;
  setTranscript: SetTranscript;
  recordProviderUsage: RecordProviderUsageFn;
  handleQuotaExhausted: (resetEpochMs: number | null) => void;
  runSkill: RunSkill;
  applyPendingChange: (change: PendingChange) => void;
  transcriptBatch: MacrotaskBatch;
  runtimeConfigRef: MutableRefObject<UserConfig>;
  promptHistoryRef: MutableRefObject<string[]>;
  promptHistoryIndexRef: MutableRefObject<number | null>;
}

interface TurnWiringResult extends AgentTranscriptHelpers, BtwController {
  pendingInputDrainer: ReturnType<typeof createPendingInputDrainer>;
  postTurnDrain: ReturnType<typeof createPostTurnDrain>;
  promptHistoryNav: PromptHistoryNav;
  applySlashResult: ApplySlashResult;
  recordPanelCommit: RecordPanelCommit;
}

export function useTurnWiring(deps: TurnWiringDeps): TurnWiringResult {
  const {
    session,
    broker,
    agent,
    setTranscript,
    recordProviderUsage,
    runSkill,
    applyPendingChange,
    transcriptBatch,
    runtimeConfigRef,
    promptHistoryRef,
    promptHistoryIndexRef,
  } = deps;

  const { agentBlockText, setAgentNested, setAgentBackgrounded, backgroundCurrentAgent } = useMemo(
    () => createAgentTranscriptHelpers({ setTranscript, agentModelByCallIdRef }),
    [setTranscript],
  );

  const { routeForkEvent } = useMemo(
    () =>
      createForkEventRouter({
        setTranscript,
        forkToCallIdRef,
        setAgentNested,
        recordProviderUsage,
        broker,
      }),
    [setTranscript, forkToCallIdRef, setAgentNested, recordProviderUsage, broker],
  );
  routeForkEventRef.current = routeForkEvent;

  const pendingInputDrainer = createPendingInputDrainer({
    applyPendingChange,
    setTranscript,
    nextTranscriptId,
  });
  const postTurnDrain = createPostTurnDrain({ applyPendingChange, setTranscript });

  const promptHistoryNav = useMemo(
    () =>
      createPromptHistoryNav({
        historyRef: promptHistoryRef,
        indexRef: promptHistoryIndexRef,
        sessionId: session.id,
      }),
    [session.id],
  );

  const applySlashResult = createApplySlashResult({
    runSkill,
    runningRef,
    applyPendingChange,
    nextTranscriptId,
    setTranscript,
    agent,
    runSubmittedTurnRef,
    transcriptBatch,
    session,
    broker,
  });

  const recordPanelCommit = createRecordPanelCommit(applySlashResult);

  const { runBtwTurn, enterBtwMode, exitBtwMode } = useMemo(
    () =>
      createBtwController({
        btwAbortRef,
        btwSessionIdRef,
        btwSeqRef,
        session,
        broker,
        runtimeConfigRef,
        recordProviderUsage,
      }),
    [session, broker, recordProviderUsage],
  );

  return {
    agentBlockText,
    setAgentNested,
    setAgentBackgrounded,
    backgroundCurrentAgent,
    pendingInputDrainer,
    postTurnDrain,
    promptHistoryNav,
    applySlashResult,
    recordPanelCommit,
    runBtwTurn,
    enterBtwMode,
    exitBtwMode,
  };
}
