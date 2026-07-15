import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from "react";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { clearLastUsage, hasServerUsage } from "@/engine/session/compact/last-usage.ts";
import { roughTokenCountEstimationForMessages } from "@/engine/session/compact/token-count.ts";
import {
  appendRecord,
  nowIso,
  rewriteSession,
  type Session,
  sessionBrokerStateKey,
  sessionMetaFromBrokerState,
  truncateRewoundTail,
} from "@/engine/session/index.ts";
import { loadPromptHistoryForCwd } from "@/kernel/storage/prompt-history.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  pendingBrokerMetaRef,
  pendingRewindPersistRef,
  sessionFinalizersRef,
  suppressBrokerPersistenceRef,
} from "@/store/session-lifecycle/index.ts";
import type { createUsageSetters } from "@/ui/app/usage-setters.ts";

export interface AppSessionRuntimeDeps {
  session: Session;
  broker: Broker;
  setState: Dispatch<SetStateAction<ReturnType<Broker["read"]>>>;
  setMainLastContext: ReturnType<typeof createUsageSetters>["setMainLastContext"];
}

export function useAppSessionRuntime(deps: AppSessionRuntimeDeps) {
  const { session, broker, setState, setMainLastContext } = deps;
  const promptHistoryRef = useRef<string[]>(loadPromptHistoryForCwd(process.cwd(), session.id));
  const promptHistoryIndexRef = useRef<number | null>(null);
  useEffect(() => {
    promptHistoryRef.current = loadPromptHistoryForCwd(process.cwd(), session.id);
    promptHistoryIndexRef.current = null;
  }, [session.id]);
  const runSessionFinalizers = useCallback((): void => {
    const finalizers = sessionFinalizersRef.current.splice(0);
    for (const finalize of finalizers) {
      try {
        const result = finalize();
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch(() => {});
        }
      } catch {}
    }
  }, []);
  const slashLifecycle = useMemo(
    () => ({
      onSessionFinalize: (handler: () => void | Promise<void>): void => {
        sessionFinalizersRef.current.push(handler);
      },
    }),
    [],
  );
  const persistedSessionBrokerStateRef = useRef(sessionBrokerStateKey(broker.read()));
  const flushDeferredPersistence = async (): Promise<void> => {
    const rewind = pendingRewindPersistRef.current;
    if (rewind) {
      pendingRewindPersistRef.current = null;
      session.append("rewind", rewind);
      let truncated = false;
      if (rewind.anchorUuid !== null) {
        truncated = await truncateRewoundTail(session, {
          anchorUuid: rewind.anchorUuid,
          preservedFromByte: rewind.preservedFromByte,
        }).catch(() => false);
      }
      if (!truncated) {
        try {
          await rewriteSession(session);
        } catch {}
      }
    }
    const meta = pendingBrokerMetaRef.current;
    if (meta) {
      pendingBrokerMetaRef.current = null;
      session.pendingMeta = null;
      await appendRecord(session, meta).catch(() => {});
    }
  };

  useEffect(() => {
    return broker.subscribe((next) => {
      setState(next);
      const key = sessionBrokerStateKey(next);
      if (key === persistedSessionBrokerStateRef.current) return;
      if (suppressBrokerPersistenceRef.current) {
        persistedSessionBrokerStateRef.current = key;
        return;
      }
      persistedSessionBrokerStateRef.current = key;
      if (!hasServerUsage() && session.records.length === 0) {
        setMainLastContext({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens:
            roughTokenCountEstimationForMessages(session.messages) +
            estimateHarnessTokens(next.provider, next.model),
        });
        clearLastUsage();
      }
      const nextMeta = sessionMetaFromBrokerState(session, next, nowIso());
      pendingBrokerMetaRef.current = nextMeta;
      session.pendingMeta = nextMeta;
    });
  }, [broker, session, setState, setMainLastContext]);

  return {
    promptHistoryRef,
    promptHistoryIndexRef,
    runSessionFinalizers,
    slashLifecycle,
    persistedSessionBrokerStateRef,
    flushDeferredPersistence,
  };
}
