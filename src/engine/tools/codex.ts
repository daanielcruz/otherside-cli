import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { currentTokens, ensureInstallationId } from "@/engine/providers/codex/auth.ts";
import { buildHeaders, CHATGPT_BASE_URL } from "@/engine/providers/codex/fingerprint.ts";
import { buildCodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import { getSessionState } from "@/engine/providers/codex/transport/state.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { WebSearchInput, WebSearchPayload } from "./common.ts";

function isAborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export async function searchCodex(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const tokens = await currentTokens();
  const ids = await ensureInstallationId();
  const session = getSessionState(ctx.sessionId);
  const requestMetadata = buildCodexRequestMetadata({
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
    requestMetadata,
    transport: "http",
  });
  headers.Accept = "application/json";

  const filters: Record<string, string[]> = {};
  if (input.allowedDomains.length > 0) filters.allowed_domains = input.allowedDomains;
  if (input.blockedDomains.length > 0) filters.blocked_domains = input.blockedDomains;
  const settings: Record<string, unknown> = {
    search_context_size: "medium",
    allowed_callers: ["direct"],
    external_web_access: true,
  };
  if (Object.keys(filters).length > 0) settings.filters = filters;

  let resp: Response;
  try {
    resp = await fetch(`${CHATGPT_BASE_URL}/alpha/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: ctx.sessionId,
        model: ctx.model,
        commands: {
          search_query: [{ q: input.query }],
          response_length: "short",
        },
        settings,
        max_output_tokens: 4096,
      }),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
  } catch (error) {
    if (isAborted(error, ctx.abortSignal)) throw new Error("web search aborted");
    throw error;
  }

  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `HTTP 401 from codex /alpha/search: ${truncateEllipsis(text, 300)} — run \`otherside login --provider codex\``,
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
      provider: "codex /alpha/search",
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (error) {
    if (isAborted(error, ctx.abortSignal)) throw new Error("web search aborted");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to decode codex web search response: ${message}`);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { output?: unknown }).output !== "string"
  ) {
    throw new Error("failed to decode codex web search response: missing output");
  }

  const decoded = payload as { output: string; results?: unknown };
  const results: WebSearchPayload["results"] = [];
  if (decoded.output.trim().length > 0) results.push(decoded.output.trim());
  if (Array.isArray(decoded.results)) {
    for (const result of decoded.results) {
      if (result && typeof result === "object") results.push(result as Record<string, unknown>);
      else if (typeof result === "string") results.push(result);
    }
  }
  if (results.length === 0) {
    results.push(`No Codex web search results found for query: ${input.query}`);
  }

  return {
    query: input.query,
    provider: ctx.provider,
    results,
    durationSeconds: (Date.now() - started) / 1000,
  };
}
