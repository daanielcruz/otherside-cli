import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import {
  currentTokens,
  ensureInstallationId,
  forceRefreshTokens,
} from "@/engine/providers/codex/auth.ts";
import { buildHeaders, RESPONSES_URL } from "@/engine/providers/codex/fingerprint.ts";
import {
  buildCodexRequestMetadata,
  type CodexRequestMetadata,
} from "@/engine/providers/codex/metadata.ts";
import {
  createCodexStreamDeadline,
  throwIfCodexDeadlineTimedOut,
} from "@/engine/providers/codex/transport/deadline.ts";
import { getSessionState } from "@/engine/providers/codex/transport/state.ts";
import { codexUsageToSseFrame, parseCodexUsageHeaders } from "@/engine/providers/codex/usage.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function buildHttpBody(
  body: unknown,
  requestMetadata: CodexRequestMetadata,
): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (src.model !== undefined) out.model = src.model;
  if (src.instructions !== undefined) out.instructions = src.instructions;
  if (src.input !== undefined) out.input = src.input;
  if (src.tools !== undefined) out.tools = src.tools;
  if (src.tool_choice !== undefined) out.tool_choice = src.tool_choice;
  if (src.parallel_tool_calls !== undefined) out.parallel_tool_calls = src.parallel_tool_calls;
  out.reasoning = src.reasoning ?? null;
  if (src.store !== undefined) out.store = src.store;
  out.stream = src.stream ?? true;
  out.include = src.include ?? [];
  if (src.service_tier !== undefined) out.service_tier = src.service_tier;
  if (src.prompt_cache_key !== undefined) out.prompt_cache_key = src.prompt_cache_key;
  if (src.text !== undefined) out.text = src.text;
  out.client_metadata = requestMetadata.clientMetadata;
  return out;
}

function buildPrewarmBody(
  body: unknown,
  requestMetadata: CodexRequestMetadata,
): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { type: "response.create" };
  if (src.model !== undefined) out.model = src.model;
  if (src.instructions !== undefined) out.instructions = src.instructions;
  if (src.tools !== undefined) out.tools = src.tools;
  out.generate = false;
  out.input = [];
  if (src.prompt_cache_key !== undefined) out.prompt_cache_key = src.prompt_cache_key;
  out.client_metadata = requestMetadata.clientMetadata;
  return out;
}

async function readBodySnippet(res: Response, maxBytes = 4096): Promise<string> {
  try {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return "";
  }
}

export async function* streamHttp(ctx: RequestContext, body: unknown): AsyncIterable<Uint8Array> {
  const tokens = await currentTokens();
  const ids = await ensureInstallationId();
  const session = getSessionState(ctx.sessionId);
  const turnMetadata = buildCodexRequestMetadata({
    ctx,
    installationId: ids.installationId,
    mainSessionId: session.conversationId,
    mainThreadId: session.threadId,
    windowGeneration: session.windowGeneration,
    requestKind: "turn",
  });
  const headers = buildHeaders({
    bearer: `Bearer ${tokens.accessToken}`,
    accountId: tokens.accountId,
    requestMetadata: turnMetadata,
    transport: "http",
  });
  const payload = buildHttpBody(body, turnMetadata);

  const prewarmEnabled = process.env.OTHERSIDE_CODEX_PREWARM !== "0";
  const isMainUserTurn = ctx.subagentLabel === undefined;
  if (prewarmEnabled && isMainUserTurn && !session.prewarmed) {
    const prewarmMetadata = buildCodexRequestMetadata({
      ctx,
      installationId: ids.installationId,
      mainSessionId: session.conversationId,
      mainThreadId: session.threadId,
      windowGeneration: session.windowGeneration,
      requestKind: "prewarm",
    });
    const prewarmHeaders = buildHeaders({
      bearer: `Bearer ${tokens.accessToken}`,
      accountId: tokens.accountId,
      requestMetadata: prewarmMetadata,
      transport: "http",
    });
    const prewarmBody = buildPrewarmBody(body, prewarmMetadata);
    const prewarmDeadline = createCodexStreamDeadline(ctx.abortSignal);
    try {
      const prewarmInit: RequestInit = {
        method: "POST",
        headers: prewarmHeaders,
        body: JSON.stringify(prewarmBody),
        signal: prewarmDeadline.signal,
      };
      const prewarmRes = await fetch(RESPONSES_URL, prewarmInit);
      void prewarmRes.body?.cancel();
      session.prewarmed = true;
    } catch {
    } finally {
      prewarmDeadline.dispose();
    }
  }

  const deadline = createCodexStreamDeadline(ctx.abortSignal);
  try {
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: deadline.signal,
    };

    let res = await fetch(RESPONSES_URL, init);
    if (res.status === 401) {
      // Reload first — another flow may have already refreshed; only hit the
      // OAuth endpoint when the stored token is the one the server rejected.
      let newTokens = await currentTokens().catch(() => null);
      if (!newTokens || newTokens.accessToken === tokens.accessToken) {
        newTokens = await forceRefreshTokens().catch(() => null);
      }
      if (newTokens && newTokens.accessToken !== tokens.accessToken) {
        const retryHeaders = buildHeaders({
          bearer: `Bearer ${newTokens.accessToken}`,
          accountId: newTokens.accountId,
          requestMetadata: turnMetadata,
          transport: "http",
        });
        const retryInit: RequestInit = {
          method: "POST",
          headers: retryHeaders,
          body: JSON.stringify(payload),
          signal: deadline.signal,
        };
        res = await fetch(RESPONSES_URL, retryInit);
      }
    }
    if (!res.ok) {
      const text = await readBodySnippet(res);
      const retryAfterHeader = res.headers.get("retry-after");
      const quota = detectQuotaExhaustion({
        status: res.status,
        body: text,
        headers: res.headers,
        retryAfterMs: parseRetryAfterHeader(retryAfterHeader),
      });
      throw new ProviderHttpError({
        provider: "codex",
        status: res.status,
        body: text,
        retryAfterHeader,
        quotaExhausted: quota.quotaExhausted,
        quotaResetEpochMs: quota.resetEpochMs,
      });
    }
    if (!res.body) {
      throw new ProviderHttpError({
        provider: "codex",
        status: 200,
        body: "empty response body",
      });
    }

    const usage = parseCodexUsageHeaders(res.headers);
    if (usage) {
      yield codexUsageToSseFrame(usage);
    }

    for await (const value of readResponseBody(res.body)) {
      deadline.arm();
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      yield chunk;
    }
  } catch (err) {
    throwIfCodexDeadlineTimedOut(deadline);
    throw err;
  } finally {
    deadline.dispose();
  }
}
