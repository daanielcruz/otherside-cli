import { askSideQuestion, type SideQuestionRetry } from "@/engine/queue/runtime/side-question.ts";
import { type Session } from "@/engine/session/index.ts";
import { createRecordProviderUsage } from "@/engine/session/usage/record-provider-usage.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  answeredBtwHistory,
  clearBtwTurns,
  completeBtwTurn,
  startBtwTurn,
} from "@/store/btw-store/index.ts";
import { dispatch } from "@/store/index.ts";

export interface BtwControllerDeps {
  btwAbortRef: { current: AbortController | null };
  btwSessionIdRef: { current: string | null };
  btwSeqRef: { current: number };
  session: Session;
  broker: Broker;
  runtimeConfigRef: { current: UserConfig };
  recordProviderUsage: ReturnType<typeof createRecordProviderUsage>;
}

export interface BtwController {
  runBtwTurn: (question: string) => Promise<void>;
  enterBtwMode: (question: string) => void;
  exitBtwMode: () => void;
}

export function createBtwController(deps: BtwControllerDeps): BtwController {
  const {
    btwAbortRef,
    btwSessionIdRef,
    btwSeqRef,
    session,
    broker,
    runtimeConfigRef,
    recordProviderUsage,
  } = deps;

  const runBtwTurn = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    btwAbortRef.current?.abort();
    const controller = new AbortController();
    btwAbortRef.current = controller;
    const turn = startBtwTurn(trimmed);
    if (btwSessionIdRef.current === null) {
      btwSeqRef.current = (btwSeqRef.current + 1) | 0;
      btwSessionIdRef.current = `${session.id}-btw-${btwSeqRef.current.toString(36)}`;
    }
    const syntheticSessionId = btwSessionIdRef.current;
    const state = broker.read();
    const ctx: RequestContext = {
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      permissionMode: state.permissionMode,
      sessionId: syntheticSessionId,
      cwd: session.cwd,
      abortSignal: controller.signal,
    };
    const history = answeredBtwHistory();
    try {
      const result = await askSideQuestion({
        question: trimmed,
        ctx,
        parentSessionId: session.id,
        parentMessages: [...session.messages],
        config: runtimeConfigRef.current,
        history,
        signal: controller.signal,
        syntheticSessionId,
        onRetry: (_event: SideQuestionRetry) => {},
        onUsage: (usage) => {
          recordProviderUsage(
            state.provider,
            state.model,
            usage.inputTokens,
            usage.outputTokens,
            0,
            0,
            0,
            {
              isFork: true,
            },
          );
        },
      });
      if (controller.signal.aborted) {
        completeBtwTurn(turn.id, {
          response: null,
          synthetic: false,
          status: "cancelled",
        });
        return;
      }
      if (result.response !== null) {
        completeBtwTurn(turn.id, {
          response: result.response,
          synthetic: result.synthetic,
          status: "answered",
        });
      } else {
        completeBtwTurn(turn.id, {
          response: null,
          synthetic: false,
          status: "error",
          error: result.aborted ? "(cancelled)" : "No response received",
        });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        completeBtwTurn(turn.id, {
          response: null,
          synthetic: false,
          status: "cancelled",
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      completeBtwTurn(turn.id, {
        response: null,
        synthetic: false,
        status: "error",
        error: msg,
      });
    } finally {
      if (btwAbortRef.current === controller) btwAbortRef.current = null;
    }
  };

  const enterBtwMode = (question: string): void => {
    dispatch({ type: "view/setBtwMode", active: true });
    void runBtwTurn(question);
  };

  const exitBtwMode = (): void => {
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    btwSessionIdRef.current = null;
    clearBtwTurns();
    dispatch({ type: "view/setBtwMode", active: false });
  };

  return { runBtwTurn, enterBtwMode, exitBtwMode };
}
