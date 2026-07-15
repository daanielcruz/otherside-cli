import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { uuidv4 } from "@/kernel/std/id.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface QueryModelOptions {
  provider?: ProviderId;
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  disableThinking?: boolean;
  timeoutMs?: number;
}

export async function queryModel(
  ctx: RequestContext,
  opts: QueryModelOptions,
): Promise<{ text: string } | { error: string }> {
  const providerId = opts.provider ?? ctx.provider;
  let provider: ReturnType<typeof providers.get>;
  try {
    provider = providers.get(providerId);
  } catch {
    return { error: `provider \`${providerId}\` is not registered` };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parentSignal = ctx.abortSignal;
  const onParentAbort = (): void => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const messages: Message[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: [{ type: "text", text: opts.systemPrompt }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: opts.userPrompt }] });

  const callCtx: RequestContext = {
    ...ctx,
    provider: providerId,
    model: opts.model ?? ctx.model,
    sessionId: `${ctx.sessionId}/oneshot-${uuidv4().slice(0, 8)}`,
    effort: null,
    agentic: false,
    disableThinking: opts.disableThinking ?? true,
    abortSignal: ctrl.signal,
  };

  let body: unknown;
  try {
    body = provider.translateRequest(callCtx, messages, []);
  } catch (e) {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
    return { error: `translateRequest failed: ${(e as Error).message}` };
  }

  let text = "";
  try {
    for await (const event of streamWithRetry(callCtx, provider, body)) {
      if (event.kind === "text_delta") text += event.text;
      else if (event.kind === "stream_reset") text = "";
      else if (event.kind === "message_stop") break;
      else if (event.kind === "error") return { error: event.error };
      else if (event.kind === "quota_exhausted") {
        throw new QuotaExhaustedError({
          provider: event.provider,
          model: event.model,
          resetEpochMs: event.resetEpochMs,
          message: event.message,
        });
      }
    }
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    const aborted = isAbortError(e) || ctrl.signal.aborted;
    return {
      error: aborted
        ? `model call timed out after ${timeoutMs}ms`
        : `model stream failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }

  if (text.trim().length === 0) return { error: "model returned empty response" };
  return { text };
}
