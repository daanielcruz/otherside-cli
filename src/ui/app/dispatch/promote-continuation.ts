import type { UserConfig } from "@/kernel/config/config.ts";
import { fireUserPromptSubmitHooks } from "@/kernel/hooks/handler.ts";
import type { RunSubmittedTurn } from "@/store/turn-run/index.ts";
import { nextTranscriptId } from "@/store/turn-tracking/index.ts";
import type { TurnContinuation } from "@/ui/app/drain/post-turn.ts";
import { formatHookOutcome } from "@/ui/app/status-text.ts";
import type { TranscriptSetters } from "@/ui/transcript/stream/setters.ts";

export interface PromoteContinuationDeps {
  runtimeConfig: UserConfig;
  setTranscript: TranscriptSetters["setTranscript"];
  handleSlash: (rawText: string) => boolean;
  runSubmittedTurn: RunSubmittedTurn;
  requestBackgroundResume: () => void;
}

// Shared "dispatch whatever the queue drain handed back" logic: a cancelled
// turn's finally and the standing background-resume driver both need to turn a
// TurnContinuation into either a slash dispatch or a real turn, identically.
// Kept dependency-free of submitted-turn.ts (deps are injected) so the two
// modules do not import each other.
export function createPromoteContinuation(
  deps: PromoteContinuationDeps,
): (continuation: TurnContinuation) => Promise<boolean> {
  const { runtimeConfig, setTranscript, handleSlash, runSubmittedTurn, requestBackgroundResume } =
    deps;

  const blockedByHook = (reason: string): void => {
    const id = nextTranscriptId("hook");
    setTranscript((t) => [...t, { id, kind: "system", text: `prompt blocked by hook: ${reason}` }]);
  };

  // Returns true only when runSubmittedTurn was actually invoked — callers that
  // pre-reserved the guard for this promotion (a forced queue drain) use that to
  // know whether to release the reservation.
  return async (continuation: TurnContinuation): Promise<boolean> => {
    const { nextText, nextSuppress, nextRestoreEntryId } = continuation;
    if (nextText === null) return false;
    let dispatched = false;
    if (nextText.trim().startsWith("/")) {
      if (!handleSlash(nextText)) {
        const hookResult = await fireUserPromptSubmitHooks(runtimeConfig, nextText);
        const failedHook = hookResult.outcomes.find((outcome) => outcome.kind !== "ok");
        if (failedHook) {
          blockedByHook(formatHookOutcome(failedHook));
        } else {
          dispatched = true;
          await runSubmittedTurn(nextText, {
            suppressUserTranscript: nextSuppress,
            additionalContext: hookResult.additionalContext,
          });
        }
      }
      requestBackgroundResume();
    } else {
      const hookResult = await fireUserPromptSubmitHooks(runtimeConfig, nextText);
      const failedHook = hookResult.outcomes.find((outcome) => outcome.kind !== "ok");
      if (failedHook) {
        blockedByHook(formatHookOutcome(failedHook));
      } else {
        dispatched = true;
        await runSubmittedTurn(nextText, {
          suppressUserTranscript: nextSuppress,
          additionalContext: hookResult.additionalContext,
          ...(nextRestoreEntryId !== undefined ? { restoreEntryId: nextRestoreEntryId } : {}),
        });
      }
    }
    return dispatched;
  };
}
