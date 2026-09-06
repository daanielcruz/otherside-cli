import type { UserConfig } from "@/kernel/config/config.ts";
import { fireUserPromptSubmitHooks } from "@/kernel/hooks/handler.ts";
import { nextTranscriptId } from "@/store/turn-tracking/index.ts";
import { formatHookOutcome } from "@/ui/app/status-text.ts";
import type { TranscriptSetters } from "@/ui/transcript/stream/setters.ts";

export interface PromptHookGateDeps {
  runtimeConfig: UserConfig;
  setTranscript: TranscriptSetters["setTranscript"];
}

export type PromptHookGate = (
  text: string,
  run: (additionalContext: string[]) => Promise<void>,
) => Promise<boolean>;

// Every prompt that becomes a MAIN turn passes here: hooks fire once, a block
// surfaces in the transcript instead of reaching the model, and the hook
// context rides into the turn. Steers to a viewed agent and queued texts stay
// outside — queued texts fire on promotion.
export function createPromptHookGate(deps: PromptHookGateDeps): PromptHookGate {
  const { runtimeConfig, setTranscript } = deps;
  return async (text, run) => {
    const hookResult = await fireUserPromptSubmitHooks(runtimeConfig, text);
    const failedHook = hookResult.outcomes.find((outcome) => outcome.kind !== "ok");
    if (failedHook) {
      const id = nextTranscriptId("hook");
      setTranscript((t) => [
        ...t,
        { id, kind: "system", text: `prompt blocked by hook: ${formatHookOutcome(failedHook)}` },
      ]);
      return false;
    }
    await run(hookResult.additionalContext);
    return true;
  };
}
