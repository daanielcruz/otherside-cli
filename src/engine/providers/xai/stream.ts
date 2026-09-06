import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { currentTokens, forceRefreshTokens } from "@/engine/providers/xai/auth.ts";
import {
  authHeaderValue,
  inferenceHeaders,
  RESPONSES_URL,
} from "@/engine/providers/xai/fingerprint.ts";
import { normalizeGrokBody } from "@/engine/providers/xai/normalize.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";

export const xaiStream: StreamFn = async function* xaiStreamFn(
  ctx,
  body,
  signal,
): AsyncIterable<Uint8Array> {
  const tokens = await currentTokens();

  const payload = JSON.stringify(normalizeGrokBody(body));
  const request = (accessToken: string): Promise<Response> =>
    fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        ...inferenceHeaders(authHeaderValue(accessToken)),
        ...connectionHeaders(ctx),
      },
      // Aux one-shot paths inject glm/anthropic-wire fields after translate; strip
      // them to the Responses dialect before the request leaves.
      body: payload,
      signal,
      ...connectionInit(ctx),
    });

  let resp = await request(tokens.accessToken);
  if (resp.status === 401) {
    // Reload first — another flow may have already refreshed; only hit the
    // OAuth endpoint when the stored token is the one the server rejected.
    let newTokens = await currentTokens().catch(() => null);
    if (!newTokens || newTokens.accessToken === tokens.accessToken) {
      newTokens = await forceRefreshTokens(tokens).catch(() => null);
    }
    if (newTokens && newTokens.accessToken !== tokens.accessToken) {
      resp = await request(newTokens.accessToken);
    }
  }

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from grok /v1/responses: ${truncateEllipsis(text, 300)} — run \`otherside login --provider xai\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "xai",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "xai /v1/responses",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
  if (!resp.body) {
    throw new Error("grok stream: response had no body");
  }

  yield* readResponseBody(resp.body);
};
