import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import {
  API_MESSAGES_URL as ANTHROPIC_MESSAGES_URL,
  fingerprint as anthropicFingerprint,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { cacheExtraUsageDisabledReason as anthropicCacheExtraUsageDisabledReason } from "@/engine/providers/anthropic/access.ts";
import { authorizationHeader as anthropicAuthorizationHeader } from "@/engine/providers/anthropic/auth.ts";
import { applyCchAttestation } from "@/engine/providers/anthropic/cch.ts";
import { ingestAnthropicHeaders } from "@/engine/providers/anthropic/rate-limits.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const anthropicStream: StreamFn = async function* anthropicStreamFn(
  ctx: RequestContext,
  body: unknown,
): AsyncIterable<Uint8Array> {
  const auth = await anthropicAuthorizationHeader();
  const fp = anthropicFingerprint(ctx);

  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...connectionHeaders(ctx),
  };

  const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers,
    body: applyCchAttestation(JSON.stringify(body)),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...connectionInit(ctx),
  });

  const overageReason = resp.headers.get("anthropic-ratelimit-unified-overage-disabled-reason");
  void anthropicCacheExtraUsageDisabledReason(overageReason);
  ingestAnthropicHeaders(resp.headers);
  const responseRequestId = resp.headers.get("request-id");
  if (responseRequestId) ctx.responseRequestId = responseRequestId;
  else delete ctx.responseRequestId;

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from /v1/messages: ${truncateEllipsis(text, 300)} — run \`otherside login --provider anthropic\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "/v1/messages",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
  if (!resp.body) {
    throw new Error("anthropic stream: response had no body");
  }

  yield* readResponseBody(resp.body);
};
