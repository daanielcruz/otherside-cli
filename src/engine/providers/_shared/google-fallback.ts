import type { RetryDecision } from "@/engine/contract/types.ts";
import { resolveProviderError } from "@/engine/providers/_shared/provider-error.ts";
import { markReasoningReplayRejected } from "@/engine/providers/_shared/reasoning-replay-state.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface RateLimitErrorShape {
  body: string;
  status?: number;
  retryAfter?: number | null;
  retryAfterHeader?: string | null;
}

interface HttpErrorShape {
  status: number;
  body: string;
}

export interface GoogleFallbackSpec {
  providerId: ProviderId;
  rateLimitErrorCtor: new (...args: never[]) => RateLimitErrorShape;
  httpErrorCtor: new (...args: never[]) => HttpErrorShape;
}

const NAMES_THOUGHT_SIGNATURE = /thought[ _]?signature/i;
const ASKS_FOR_THOUGHT_SIGNATURE =
  /missing[^\n]{0,24}thought[ _]?signature|(?:must|should) (?:include|contain|have)[^\n]{0,24}thought[ _]?signature|thought[ _]?signature[^\n]{0,24}(?:required|missing)/i;

// A replayed thought signature the API can no longer verify comes back as a
// 400 naming the signature ("Invalid thought signature", "Corrupted thought
// signature."), so a plain validation error on some other field never
// suppresses the session. Any wording counts, since one the matcher misses
// leaves the session failing on every turn. The inverse complaint — a
// signature the request was missing — must not match, or the retry would drop
// the very field the API asked for.
function carriesThoughtSignatureRejection(error: unknown, spec: GoogleFallbackSpec): boolean {
  if (!(error instanceof spec.httpErrorCtor)) return false;
  if ((error as HttpErrorShape).status !== 400) return false;
  const message = error instanceof Error ? error.message : "";
  const haystack = `${(error as HttpErrorShape).body}\n${message}`;
  return NAMES_THOUGHT_SIGNATURE.test(haystack) && !ASKS_FOR_THOUGHT_SIGNATURE.test(haystack);
}

export function makeGoogleRecoverableError(
  spec: GoogleFallbackSpec,
): (error: unknown, ctx: RequestContext, attempt?: number) => RetryDecision {
  return (error, ctx, attempt) => {
    // Drop signature replay for the rest of the session and retry once — the
    // rebuilt request carries the placeholder signature instead. Only the first
    // hit retries; a still-failing turn falls through to a normal failure.
    if (
      carriesThoughtSignatureRejection(error, spec) &&
      markReasoningReplayRejected(ctx.sessionId, spec.providerId)
    ) {
      return { kind: "retry", delayMs: 0, reason: "dropped stale thought signature" };
    }
    const rateLimit = rateLimitError(error, spec);
    if (rateLimit !== null) {
      return classifyProviderError(toHttpError(spec.providerId, 429, rateLimit.body, rateLimit), {
        attempt: attempt ?? 1,
        provider: spec.providerId,
        model: ctx.model,
      });
    }

    if (error instanceof spec.httpErrorCtor) {
      const httpError = error as HttpErrorShape;
      return classifyProviderError(toHttpError(spec.providerId, httpError.status, httpError.body), {
        attempt: attempt ?? 1,
        provider: spec.providerId,
        model: ctx.model,
      });
    }

    return classifyProviderError(error, {
      attempt: attempt ?? 1,
      provider: spec.providerId,
      model: ctx.model,
    });
  };
}

function rateLimitError(error: unknown, spec: GoogleFallbackSpec): RateLimitErrorShape | null {
  if (!(error instanceof spec.rateLimitErrorCtor)) return null;
  const rateLimit = error as RateLimitErrorShape;
  return rateLimit.status === undefined || rateLimit.status === 429 ? rateLimit : null;
}

function toHttpError(
  provider: string,
  status: number,
  body: string,
  rateLimit?: RateLimitErrorShape,
): ProviderHttpError {
  const retryAfterHeader = retryAfter(rateLimit);
  const classified = resolveProviderError({
    provider,
    status,
    body,
    headers: { "retry-after": retryAfterHeader },
  });
  return new ProviderHttpError({
    provider,
    status,
    body,
    retryAfterHeader,
    quotaExhausted: classified.class === "quota_exhausted",
    quotaResetEpochMs: classified.quotaResetEpochMs ?? null,
  });
}

function retryAfter(rateLimit: RateLimitErrorShape | undefined): string | null {
  if (rateLimit === undefined) return null;
  if (typeof rateLimit.retryAfter === "number") return String(rateLimit.retryAfter);
  return rateLimit.retryAfterHeader ?? null;
}
