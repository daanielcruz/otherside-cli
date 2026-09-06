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
import { cachedExtraUsageBlockReason as anthropicCacheExtraUsageDisabledReason } from "@/engine/providers/anthropic/access.ts";
import { currentTokens, forceRefreshTokens } from "@/engine/providers/anthropic/auth.ts";
import { applyCchAttestation } from "@/engine/providers/anthropic/cch.ts";
import { ingestAnthropicHeaders } from "@/engine/providers/anthropic/rate-limits.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function requestHeaders(
  accessToken: string,
  fp: { userAgent: string; extraHeaders: Record<string, string> },
  ctx: RequestContext,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...connectionHeaders(ctx),
  };
}

function throwUnauthorized(text: string): never {
  throw new Error(
    `HTTP 401 from /v1/messages: ${truncateEllipsis(text, 300)} — run \`otherside login --provider anthropic\``,
  );
}

export const anthropicStream: StreamFn = async function* anthropicStreamFn(
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const tokens = await currentTokens();
  const fp = anthropicFingerprint(ctx, body);
  const payload = applyCchAttestation(JSON.stringify(body));

  let resp = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: requestHeaders(tokens.accessToken, fp, ctx),
    body: payload,
    signal,
    ...connectionInit(ctx),
  });

  if (resp.status === 401) {
    // Reload first — another flow may have already refreshed; only hit the
    // OAuth endpoint when the stored token is the one the server rejected.
    let newTokens = await currentTokens().catch(() => null);
    if (!newTokens || newTokens.accessToken === tokens.accessToken) {
      newTokens = await forceRefreshTokens(tokens).catch(() => null);
    }
    if (newTokens && newTokens.accessToken !== tokens.accessToken) {
      resp = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: requestHeaders(newTokens.accessToken, fp, ctx),
        body: payload,
        signal,
        ...connectionInit(ctx),
      });
    } else {
      const text = await resp.text().catch(() => "");
      throwUnauthorized(text);
    }
  }

  const overageReason = resp.headers.get("anthropic-ratelimit-unified-overage-disabled-reason");
  void anthropicCacheExtraUsageDisabledReason(overageReason);
  ingestAnthropicHeaders(resp.headers);
  const responseRequestId = resp.headers.get("request-id");
  if (responseRequestId) ctx.responseRequestId = responseRequestId;
  else delete ctx.responseRequestId;

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throwUnauthorized(text);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "anthropic",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "anthropic",
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
