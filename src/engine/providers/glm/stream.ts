import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { currentGlmChatCredential } from "@/engine/providers/glm/auth.ts";
import {
  API_MESSAGES_URL as GLM_MESSAGES_URL,
  authHeader as glmAuthHeader,
  fingerprint as glmFingerprint,
} from "@/engine/providers/glm/fingerprint.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const glmStream: StreamFn = async function* glmStreamFn(
  ctx: RequestContext,
  body: unknown,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const chatCredential = await currentGlmChatCredential();
  const fp = glmFingerprint(ctx);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": fp.userAgent,
    ...fp.extraHeaders,
    ...glmAuthHeader(chatCredential),
    ...connectionHeaders(ctx),
  };

  const resp = await fetch(GLM_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    ...connectionInit(ctx),
  });

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from glm /anthropic/v1/messages: ${truncateEllipsis(text, 300)} — run \`otherside login --provider glm\``,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const retryAfterHeader = resp.headers.get("retry-after");
    const quota = detectQuotaExhaustion({
      provider: "glm",
      status: resp.status,
      headers: resp.headers,
      body: text,
      retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
    });
    throw new ProviderHttpError({
      provider: "glm /anthropic/v1/messages",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
  if (!resp.body) {
    throw new Error("glm stream: response had no body");
  }

  yield* readResponseBody(resp.body);
};
