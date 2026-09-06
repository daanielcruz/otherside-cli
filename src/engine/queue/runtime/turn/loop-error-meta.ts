import type { RetryDecisionDetailed } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";

/** Error meta for failures the turn loop itself raises (caps, refusals, halts). */
export function loopErrorMeta(opts: {
  message: string;
  provider: string;
  model: string;
  attempt: number;
}): ErrorMeta {
  const decision: RetryDecisionDetailed = {
    kind: "fail",
    reason: opts.message,
    userMessage: opts.message,
  };
  return classifyError({
    err: new Error(opts.message),
    decision,
    provider: opts.provider,
    model: opts.model,
    attempt: opts.attempt,
    source: "turn-loop",
  });
}
