import type { RetryDecision } from "@/engine/contract/types.ts";
import { resolveProviderError } from "@/engine/providers/_shared/provider-error.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
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

export function makeGoogleRecoverableError(
  spec: GoogleFallbackSpec,
): (error: unknown, ctx: RequestContext, attempt?: number) => RetryDecision {
  return (error, ctx, attempt) => {
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
