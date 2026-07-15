import { emitQueue } from "@/engine/queue/emit.ts";
import { getQueueMessages } from "@/store/index.ts";
import { handleSlashRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import { compactTerminalRef } from "@/store/turn-status/index.ts";
import { createPromoteContinuation } from "@/ui/app/dispatch/promote-continuation.ts";
import type { DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";

export function createRequestBackgroundResume(
  deps: Pick<
    DispatchLoopDeps,
    | "agent"
    | "getBgTasksOpen"
    | "autoResumeDispatch"
    | "turnGuard"
    | "postTurnDrain"
    | "runtimeConfig"
    | "setTranscript"
  >,
): () => void {
  const { agent, autoResumeDispatch, turnGuard, postTurnDrain, runtimeConfig, setTranscript } =
    deps;

  // Single resume driver for queued user input, pending background-task results,
  // and parked auto-turn notifications. Gated on `turnGuard.active` rather than
  // the UI's `runningRef` flag: runningRef can go stale-false while a cancelled
  // turn is still unwinding (the cancellation grace timer flips it early), which
  // would let this driver dispatch a second, concurrent turn on top of the one
  // still finishing. turnGuard.active is the synchronous source of truth for
  // "live or about to be" and can't be fooled by that gap. The debounce
  // (autoResumeDispatch) collapses concurrent triggers into one re-dispatch;
  // reserve() right before dispatching closes the remaining window between the
  // debounce firing and the guard actually being claimed.
  const requestBackgroundResume = (): void => {
    const canResume = (): boolean =>
      !turnGuard.active &&
      (getQueueMessages().length > 0 ||
        (agent.injections.peek().length > 0 && !compactTerminalRef.current) ||
        emitQueue.hasPendingAutoTurn());
    if (!canResume()) return;
    autoResumeDispatch.arm({
      onTimeout: () => {
        if (!canResume()) return;
        if (getQueueMessages().length > 0) {
          // Standing queue processor: promote queued input
          // directly instead of dispatching an empty resume. An empty resume
          // after e.g. a compact ends in a user-role message, so it would fire
          // a full unprompted provider request (owesAssistantResponse,
          // src/engine/queue/runtime/turn/loop.ts:162) before the queued slash
          // ever got a chance to run — the "invisible until an extra turn"
          // symptom this driver now avoids.
          const continuation = postTurnDrain();
          if (continuation.nextText === null) {
            if (!canResume() || !turnGuard.reserve()) return;
            void runSubmittedTurnRef.current("");
            return;
          }
          const isSlash = continuation.nextText.trim().startsWith("/");
          // A slash needs no guard: compact begin()s the guard itself, and any
          // other slash command runs synchronously with no turn involved.
          if (!isSlash && !turnGuard.reserve()) return;
          void promoteContinuation(continuation).then((dispatched) => {
            if (isSlash || dispatched) return;
            turnGuard.cancelReservation();
            requestBackgroundResume();
          });
          return;
        }
        if (!turnGuard.reserve()) return;
        void runSubmittedTurnRef.current("");
      },
    });
  };

  // handleSlash is created after this factory (loop.ts wires
  // requestBackgroundResume before handleSlash), so it's read through a module
  // ref, mirroring the existing runSubmittedTurnRef pattern.
  const promoteContinuation = createPromoteContinuation({
    runtimeConfig,
    setTranscript,
    handleSlash: (text) => handleSlashRef.current(text),
    runSubmittedTurn: (text, opts) => runSubmittedTurnRef.current(text, opts),
    requestBackgroundResume,
  });

  return requestBackgroundResume;
}
