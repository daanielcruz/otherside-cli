import { connectionHeaders, connectionInit } from "@/engine/providers/_shared/connection.ts";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  parseRetryAfterHeader,
} from "@/engine/providers/_shared/retry.ts";
import { readResponseBody } from "@/engine/providers/_shared/stream-body.ts";
import { currentConfig } from "@/engine/providers/openai/auth.ts";
import {
  authHeader,
  DEFAULT_BASE_URL,
  endpointFor,
  fingerprint,
} from "@/engine/providers/openai/fingerprint.ts";
import type { OpenAiTranslated } from "@/engine/providers/openai/translate.ts";
import type { StreamFn } from "@/engine/transport/_infra/classify/types.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

async function fetchOrUnreachable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw unreachableError(url, err);
  }
}

function unreachableError(url: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const isDefault = url.startsWith(DEFAULT_BASE_URL);
  const hint = isDefault
    ? `default URL ${DEFAULT_BASE_URL} expects LM Studio on localhost. Start LM Studio, or run \`/login openai\` to set a different base URL, or export OTHERSIDE_OPENAI_BASE_URL=<url>`
    : `verify the base URL is reachable, then run \`/login openai\` or export OTHERSIDE_OPENAI_BASE_URL=<url>`;
  return new Error(`openai: cannot reach ${url} (${reason}). ${hint}`);
}

interface SimpleChatResponse {
  model_instance_id?: string;
  model?: string;
  output?:
    | string
    | Array<{ type?: string; content?: string }>
    | { type?: string; content?: string };
  response_id?: string;
}

export const stream: StreamFn = async function* openaiCustomStream(
  ctx: RequestContext,
  body: unknown,
): AsyncIterable<Uint8Array> {
  const cfg = await currentConfig();
  const fp = fingerprint(ctx);
  const target = endpointFor(cfg.baseUrl);
  const translated = body as OpenAiTranslated;

  const baseHeaders: Record<string, string> = {
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    ...authHeader(cfg.apiKey),
    ...connectionHeaders(ctx),
  };

  if (target.kind === "simple_chat") {
    const headers: Record<string, string> = { ...baseHeaders, Accept: "application/json" };
    const resp = await fetchOrUnreachable(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(translated.simple),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...connectionInit(ctx),
    });
    await assertOk(resp, target.url);
    const raw = (await resp.json()) as SimpleChatResponse;
    yield* synthesizeChunks(raw, translated.chat.model);
    return;
  }

  const payload = translated.chat;
  if (!payload.stream) payload.stream = true;
  payload.stream_options = { include_usage: true };
  if (cfg.outputTokenLimit) payload.max_tokens = cfg.outputTokenLimit;
  let resp = await fetchOrUnreachable(target.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(payload),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...connectionInit(ctx),
  });
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    const text = await resp.text().catch(() => "");
    if (/stream_options|include_usage/i.test(text)) {
      delete payload.stream_options;
      resp = await fetchOrUnreachable(target.url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(payload),
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...connectionInit(ctx),
      });
    } else {
      throw openAiError(resp.status, target.url, text);
    }
  }
  await assertOk(resp, target.url);
  if (!resp.body) {
    throw new Error("openai stream: response had no body");
  }
  yield* readResponseBody(resp.body);
};

export const openaiCompletionsStream: StreamFn = stream;

function* synthesizeChunks(resp: SimpleChatResponse, fallbackModel: string): Iterable<Uint8Array> {
  const enc = new TextEncoder();
  const id = resp.response_id ?? `chatcmpl-${Math.floor(Date.now() / 1000)}`;
  const model = resp.model_instance_id ?? resp.model ?? fallbackModel;
  const created = Math.floor(Date.now() / 1000);
  const blocks = simpleOutputBlocks(resp.output);

  yield enc.encode(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`,
  );

  for (const block of blocks) {
    const kind = (block.type ?? "message").toLowerCase();
    const content = block.content ?? "";
    if (!content) continue;
    const delta = kind === "reasoning" ? { reasoning_content: content } : { content };
    yield enc.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  }

  yield enc.encode(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  yield enc.encode("data: [DONE]\n\n");
}

function simpleOutputBlocks(
  output: SimpleChatResponse["output"],
): Array<{ type?: string; content?: string }> {
  if (!output) return [];
  if (typeof output === "string") return [{ type: "message", content: output }];
  if (Array.isArray(output)) return output;
  if (typeof output === "object" && typeof output.content === "string") return [output];
  return [];
}

async function assertOk(resp: Response, url: string): Promise<void> {
  if (resp.status === 401) {
    const text = await resp.text().catch(() => "");
    throw openAiError(401, url, text);
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
      provider: url,
      status: resp.status,
      body: text,
      retryAfterHeader,
      shouldRetryHeader: resp.headers.get("x-should-retry"),
      quotaExhausted: quota.quotaExhausted,
      quotaResetEpochMs: quota.resetEpochMs,
    });
  }
}

function openAiError(status: number, url: string, text: string): Error {
  if (status === 401) {
    return new Error(
      `HTTP 401 from ${url}: ${truncateEllipsis(text, 300)} — set api key in \`/config → Providers → Custom\``,
    );
  }
  return new Error(`HTTP ${status} from ${url}: ${truncateEllipsis(text, 500)}`);
}
