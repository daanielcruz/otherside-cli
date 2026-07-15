import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { emitTerminalProgress } from "@/kernel/std/terminal-progress.ts";
import { appStore, dispatch, useAppSelect } from "@/store/index.ts";
import { useExitPendingController } from "@/ui/app/controllers/exit-pending.ts";

export function useAppProgress() {
  const busy = useAppSelect((s) => s.view.busy);
  useEffect(() => {
    emitTerminalProgress(busy ? "indeterminate" : "completed");
  }, [busy]);
  const setBusy = useCallback<Dispatch<SetStateAction<boolean>>>((next): void => {
    const value = typeof next === "function" ? next(appStore.getState().view.busy) : next;
    dispatch({ type: "view/setBusy", busy: value });
  }, []);
  const progressStartedAt = useAppSelect((s) => s.view.progressStartedAt);
  const setProgressStartedAt = useCallback<Dispatch<SetStateAction<number | null>>>(
    (next): void => {
      const value =
        typeof next === "function" ? next(appStore.getState().view.progressStartedAt) : next;
      dispatch({ type: "view/setProgressStartedAt", startedAt: value });
    },
    [],
  );
  const viewState = useAppSelect((s) => s.view);
  const quotaPanel = viewState.quotaPanel;
  const errorPanel = viewState.errorPanel;
  const retryStatus = viewState.retryStatus;
  const [, setProgressInputTokens] = useState(0);
  const spinnerMode = viewState.spinnerMode;
  const thinkingStatus = viewState.thinkingStatus;
  const turnVerb = viewState.turnVerb;
  const progressTipIndex = viewState.turnTipIndex ?? 0;
  const exitPendingController = useExitPendingController();
  const exitPendingKey = exitPendingController.pendingKey;
  const armExitPending = exitPendingController.arm;
  const clearExitPending = exitPendingController.clear;
  const isExitArmed = exitPendingController.isArmed;
  const autoResumeDispatch = useMemo(() => createAutoClearDispatch({ holdMs: 50 }), []);
  const flushParkedDispatch = useMemo(() => createAutoClearDispatch({ holdMs: 50 }), []);
  const cancellationGraceDispatch = useMemo(() => createAutoClearDispatch({ holdMs: 1500 }), []);
  useEffect(() => {
    return () => {
      autoResumeDispatch.clear();
      flushParkedDispatch.clear();
      cancellationGraceDispatch.clear();
    };
  }, [autoResumeDispatch, cancellationGraceDispatch]);

  return {
    busy,
    setBusy,
    progressStartedAt,
    setProgressStartedAt,
    viewState,
    quotaPanel,
    errorPanel,
    retryStatus,
    setProgressInputTokens,
    spinnerMode,
    thinkingStatus,
    turnVerb,
    progressTipIndex,
    exitPendingKey,
    armExitPending,
    clearExitPending,
    isExitArmed,
    autoResumeDispatch,
    flushParkedDispatch,
    cancellationGraceDispatch,
  };
}
