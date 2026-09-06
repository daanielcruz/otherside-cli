import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { currentApiKey as currentKimiApiKey } from "@/engine/providers/kimi/auth.ts";
import {
  API_MESSAGES_URL as KIMI_MESSAGES_URL,
  authHeader as kimiAuthHeader,
  fingerprint as kimiFingerprint,
} from "@/engine/providers/kimi/fingerprint.ts";
import { refreshKimiQuotaWarning } from "@/engine/providers/kimi/usage.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const kimiStream: StreamFn = async function* kimiStreamFn(
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const apiKey = await currentKimiApiKey();
  const fp = kimiFingerprint(ctx);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...kimiAuthHeader(apiKey),
    ...connectionHeaders(ctx),
  };

  const resp = await fetch(KIMI_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    ...connectionInit(ctx),
  });

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from kimi /coding/v1/messages: ${truncateEllipsis(text, 300)} — run \`otherside login --provider kimi\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "kimi",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "kimi /coding/v1/messages",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
  if (!resp.body) {
    throw new Error("kimi stream: response had no body");
  }

  yield* readResponseBody(resp.body);
  void refreshKimiQuotaWarning().catch(() => {});
};
