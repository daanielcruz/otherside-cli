import type { Provider } from "@/engine/contract/types.ts";
import { assembleProviderTurn } from "@/engine/translator/assemble.ts";
import { setAssembledTurn } from "@/engine/translator/assembled.ts";
import type { AssembleArgs } from "@/engine/translator/types.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface RunRoundParams {
  ctx: RequestContext;
  provider: Provider;
  assemble: Omit<AssembleArgs, "ctx" | "provider">;
  persistAssembledTurn?: boolean;
  retryOpts?: { maxAttempts?: number; baseDelayMs?: number };
}

export function runRound(params: RunRoundParams): AsyncIterable<ProviderEvent> {
  const { ctx, provider, assemble, persistAssembledTurn, retryOpts } = params;
  return streamWithRetry(
    ctx,
    provider,
    () => {
      const turn = assembleProviderTurn({ ...assemble, ctx, provider });
      if (persistAssembledTurn) {
        setAssembledTurn(ctx.sessionId, { harness: turn.harness, tools: turn.tools });
      }
      return provider.translateRequest(ctx, turn.messages, turn.tools);
    },
    retryOpts,
  );
}
