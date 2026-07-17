import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { currentApiKey as currentMinimaxApiKey } from "@/engine/providers/minimax/auth.ts";
import {
  API_MESSAGES_URL as MINIMAX_MESSAGES_URL,
  authHeader as minimaxAuthHeader,
  fingerprint as minimaxFingerprint,
} from "@/engine/providers/minimax/fingerprint.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const minimaxStream: StreamFn = async function* minimaxStreamFn(
  ctx: RequestContext,
  body: unknown,
): AsyncIterable<Uint8Array> {
  const apiKey = await currentMinimaxApiKey();
  const fp = minimaxFingerprint(ctx);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...minimaxAuthHeader(apiKey),
    ...connectionHeaders(ctx),
  };

  const resp = await fetch(MINIMAX_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...connectionInit(ctx),
  });

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from minimax /anthropic/v1/messages: ${truncateEllipsis(text, 300)} — run \`otherside login --provider minimax\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "minimax",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "minimax /anthropic/v1/messages",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
  if (!resp.body) {
    throw new Error("minimax stream: response had no body");
  }

  yield* readResponseBody(resp.body);
};
