import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import {
  type ErrorMeta,
  QuotaExhaustedError,
  type RequestFailure,
} from "@/kernel/std/types/error-meta.ts";

/** What the goal check concluded at the end of a turn that otherwise finished. */
export type GoalCheckOutcome =
  | "met"
  | "impossible"
  | "not_met"
  | "deferred"
  | "failed"
  | "timed_out";

/** Why a turn's loop stopped, read once nothing more of the turn will run. */
export type TurnEnding =
  | { reason: "completed"; goalCheck?: GoalCheckOutcome }
  | { reason: "cancelled" }
  | { reason: "context_full" }
  | { reason: "model_failed" }
  | { reason: "tool_call_unreadable" }
  | { reason: "request_failed"; failure: RequestFailure };

export function requestFailed(failure: RequestFailure): TurnEnding {
  return { reason: "request_failed", failure };
}

/** The failure a classified provider error stands for. */
export function requestFailureOf(meta: ErrorMeta | undefined): RequestFailure {
  if (meta === undefined) return "unclassified";
  const resolved = meta.providerContext?.failure;
  if (resolved !== undefined) return resolved;
  switch (meta.errorClass) {
    case "quota-rate-limit":
      return "usage_limit";
    case "context-window":
      return "context_full";
    case "request-too-large":
      return "rejected";
    case "auth":
      return "auth";
    case "api-retryable-exhausted":
    case "network-transient":
      return "transient";
    default:
      return "unclassified";
  }
}

/** The failure an error thrown out of the turn stands for. */
export function requestFailureOfThrown(
  err: unknown,
  route: { provider: string; model: string },
): RequestFailure {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  if (err instanceof QuotaExhaustedError || cause instanceof QuotaExhaustedError) {
    return "usage_limit";
  }
  return requestFailureOf(
    classifyError({
      err: cause,
      decision: classifyProviderError(cause, { attempt: 1, provider: route.provider }),
      provider: route.provider,
      model: route.model,
      attempt: 1,
      source: "stream-retry",
    }),
  );
}
