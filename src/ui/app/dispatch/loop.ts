import { isImmediateSlash } from "@/commands/immediate.ts";
import { resumeViewedAgent, steerViewedAgent } from "@/engine/background/subagents/view-input.ts";
import { get as getBackgroundTask } from "@/engine/background/tasks/background.ts";
import { revokeLastUnansweredUserMessage } from "@/engine/session/index.ts";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import { fireUserPromptSubmitHooks } from "@/kernel/hooks/handler.ts";
import { clearBtwTurns } from "@/store/btw-store/index.ts";
import { appStore, dispatch, overlayStack } from "@/store/index.ts";
import { handleSlashRef, runningRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import { pendingErrorRevokeRef } from "@/store/turn-status/index.ts";
import { nextTranscriptId, routeForkEventRef } from "@/store/turn-tracking/index.ts";
import { createRequestBackgroundResume } from "@/ui/app/dispatch/background-resume.ts";
import { createHandleSlash } from "@/ui/app/dispatch/slash.ts";
import { createRunSubmittedTurn } from "@/ui/app/dispatch/submitted-turn.ts";
import type { DispatchLoop, DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";
import { formatHookOutcome } from "@/ui/app/status-text.ts";
import { expandToContentBlocks } from "@/ui/input/paste/references.ts";

// Turn / dispatch loop: prompt submission, slash routing, the streaming turn
// runner, and post-turn queue drain. Instantiated inline on every render so the
// returned handlers capture the freshest reactive values (identical semantics to
// the previous inline definitions); shared mutable turn state lives in the
// @/store/turn-* slices rather than being threaded through props.
export function createDispatchLoop(deps: DispatchLoopDeps): DispatchLoop {
  const {
    session,
    btwMode,
    runtimeConfig,
    clearExitPending,
    runBtwTurn,
    promptHistoryNav,
    pushQueued,
    setTranscript,
    setLoginInitialProvider,
    promptHistoryIndexRef,
    pasteStoreRef,
  } = deps;

  const requestBackgroundResume = createRequestBackgroundResume(deps);
  const handleSlash = createHandleSlash(deps, requestBackgroundResume);
  // createRequestBackgroundResume is built before handleSlash exists, so its
  // standing queue processor cannot capture it directly — it reads the live
  // handler through this ref instead (same pattern as runSubmittedTurnRef,
  // assigned once the dispatch loop's handlers are wired in controller.tsx).
  handleSlashRef.current = handleSlash;
  const runSubmittedTurn = createRunSubmittedTurn(deps, { handleSlash, requestBackgroundResume });

  const handleErrorAction = (id: ErrorActionId): void => {
    dispatch({ type: "view/hideErrorPanel" });
    if (id === "retry" || id === "continue-anyway") {
      pendingErrorRevokeRef.current = false;
      // Mirrors the local-input gate below: a turn already live means this
      // resume is stale (or superseded) — no-op rather than racing a second
      // dispatch. There is no text to queue for an empty resume.
      if (!runningRef.current) void runSubmittedTurnRef.current("");
    } else if (id === "switch-model") {
      pendingErrorRevokeRef.current = false;
      setLoginInitialProvider(undefined);
      overlayStack.open("model");
    } else if (id === "compact") {
      pendingErrorRevokeRef.current = false;
      handleSlash("/compact");
    } else {
      if (pendingErrorRevokeRef.current) {
        revokeLastUnansweredUserMessage(session);
        pendingErrorRevokeRef.current = false;
      }
    }
  };

  const onSubmit = async (text: string): Promise<void> => {
    if (text.trim().length === 0) return;
    clearExitPending();
    promptHistoryIndexRef.current = null;
    promptHistoryNav.push(text);
    if (text.trim().startsWith("/")) {
      if (runningRef.current && !isImmediateSlash(text)) {
        pushQueued(text);
        return;
      }
      // Expand paste placeholders before the slash is parsed, so /goal (and any
      // command that reads args) sees the real pasted text, not the [Pasted #N]
      // reference token. The queue path already expands via `.expanded`.
      const slashText = expandToContentBlocks(text, pasteStoreRef.current).text || text;
      if (handleSlash(slashText)) return;
    }
    // Text submitted while an agent view is open goes to the VIEWED agent,
    // never to the main loop: a running agent gets it as steering at its next
    // queued-input boundary; a finished agent resumes with it as a new prompt.
    // Slash commands (handled above) stay on the main loop.
    const viewingAgentId = appStore.getState().view.viewingAgentId;
    if (viewingAgentId !== null) {
      const task = getBackgroundTask(viewingAgentId);
      if (task?.kind === "agent" && task.forkId !== undefined) {
        const expanded = expandToContentBlocks(text, pasteStoreRef.current);
        const blocks =
          expanded.blocks.length > 0
            ? expanded.blocks
            : [{ type: "text" as const, text: expanded.text.length > 0 ? expanded.text : text }];
        const msgText = expanded.text.length > 0 ? expanded.text : text;
        if (task.status === "running") {
          await steerViewedAgent({
            task,
            sessionId: deps.session.id,
            cwd: deps.session.cwd,
            text: msgText,
            blocks,
          });
        } else {
          await resumeViewedAgent({
            task,
            sessionId: deps.session.id,
            cwd: deps.session.cwd,
            text: msgText,
            blocks,
            agent: deps.agent,
            eventSink: (event) => routeForkEventRef.current(event),
          });
        }
      }
      return;
    }
    if (btwMode) {
      if (text.trim() === "x" || text.trim() === "X") {
        clearBtwTurns(true);
        return;
      }
      void runBtwTurn(text);
      return;
    }
    if (runningRef.current) {
      pushQueued(text);
      return;
    }
    const hookResult = await fireUserPromptSubmitHooks(runtimeConfig, text);
    const failedHook = hookResult.outcomes.find((outcome) => outcome.kind !== "ok");
    if (failedHook) {
      const id = nextTranscriptId("hook");
      setTranscript((t) => [
        ...t,
        {
          id,
          kind: "system",
          text: `prompt blocked by hook: ${formatHookOutcome(failedHook)}`,
        },
      ]);
      return;
    }
    await runSubmittedTurn(text, {
      additionalContext: hookResult.additionalContext,
    });
  };

  return { onSubmit, runSubmittedTurn, handleErrorAction, requestBackgroundResume };
}
