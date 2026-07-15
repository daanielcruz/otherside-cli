import { useEffect, useMemo, useRef } from "react";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import type { Session } from "@/engine/session/index.ts";
import type { AutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { compactRunningRef, runningRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import type { useAppTaskState } from "@/ui/app/hooks/use-app-task-state.ts";
import type { useAppTranscript } from "@/ui/app/hooks/use-app-transcript.ts";
import { useAsyncCompletionResume } from "@/ui/app/hooks/use-async-completion-resume.ts";
import { useRemoteSync } from "@/ui/app/hooks/use-remote-sync.ts";
import { useImageCacheLifecycle } from "@/ui/hooks/use-image-cache-lifecycle.ts";

export interface AppTurnRuntimeDeps {
  session: Session;
  broker: Broker;
  getBgTasksOpen: ReturnType<typeof useAppTaskState>["getBgTasksOpen"];
  setBgTasks: ReturnType<typeof useAppTaskState>["setBgTasks"];
  setBgTasksOpen: ReturnType<typeof useAppTaskState>["setBgTasksOpen"];
  setWorkflowTasks: ReturnType<typeof useAppTaskState>["setWorkflowTasks"];
  setTranscript: ReturnType<typeof useAppTranscript>["setTranscript"];
  flushParkedDispatch: AutoClearDispatch;
}

export function useAppTurnRuntime(deps: AppTurnRuntimeDeps) {
  const {
    session,
    broker,
    getBgTasksOpen,
    setBgTasks,
    setBgTasksOpen,
    setWorkflowTasks,
    setTranscript,
    flushParkedDispatch,
  } = deps;
  const pasteStoreRef = useRef(createPasteStore(session.id));
  // Stable ref to the dispatch loop's bg-resume driver. Subscribers (bg-task
  // completion, queue change) cutuca this to drain queued input that landed
  // outside a turn's finally (the bug: msgs typed after Esc with a bg task
  // running never got promoted once the bg task completed).
  const requestBackgroundResumeRef = useRef<() => void>(() => {});
  const transitionedTasksRef = useRef(new Set<string>());
  const transitionedWorkflowTasksRef = useRef(new Set<string>());
  useEffect(() => {
    transitionedTasksRef.current.clear();
    transitionedWorkflowTasksRef.current.clear();
  }, [session.id]);
  useImageCacheLifecycle(session.id, pasteStoreRef.current);

  useRemoteSync({ session, broker, runSubmittedTurnRef });
  // Sole SoT for the live turn's generation, replacing the old boolean cancel
  // flag: abort() (cancel/clear) bumps the generation so a cancelled turn's
  // finally settles to a no-op instead of racing the cancel and re-running it.
  const turnGuard = useMemo(() => new TurnGuard(), []);
  useAsyncCompletionResume({
    getBgTasksOpen,
    runningRef,
    requestBackgroundResumeRef,
    transitionedTasksRef,
    transitionedWorkflowTasksRef,
    compactRunningRef,
    setBgTasks,
    setBgTasksOpen,
    setWorkflowTasks,
    setTranscript,
    flushParkedDispatch,
  });
  return {
    pasteStoreRef,
    requestBackgroundResumeRef,
    turnGuard,
  };
}
