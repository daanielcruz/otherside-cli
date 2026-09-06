import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import {
  assembleProviderTurn,
  getAssembledTurn,
  type ProviderToolDeclaration,
  sanitizeMessages,
} from "@/engine/translator/index.ts";
import { streamWithRetry } from "@/engine/transport/_infra/classify/retry.ts";
import type { ComposedHarness, InjectionQueue } from "@/harness/composer/injections.ts";
import { buildCompactSummaryPrompt } from "@/harness/routines/compact/index.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { groupByApiRound, trimHeadGroupsByCount } from "./grouping.ts";
import { MICRO_COMPACT_CLEARED_MESSAGE } from "./micro.ts";
import { estimateConversationTokens } from "./token-count.ts";

export class EmptyCompactSummaryError extends Error {
  constructor() {
    super("compact summary fork returned empty text");
    this.name = "EmptyCompactSummaryError";
  }
}

export class CompactPromptTooLongError extends Error {
  readonly tokenGap: number | undefined;
  constructor(tokenGap?: number) {
    super("compact summary fork rejected payload as too long after retries");
    this.name = "CompactPromptTooLongError";
    this.tokenGap = tokenGap;
  }
}

export class CompactStreamError extends Error {
  constructor(reason: string) {
    super(`compact summary fork stream error: ${reason}`);
    this.name = "CompactStreamError";
  }
}

export class CompactRefusalError extends Error {
  constructor(reason?: string) {
    super(reason ? `compaction refused: ${reason}` : "compaction refused");
    this.name = "CompactRefusalError";
  }
}

// Match the main agent envelope (the compact request uses max_tokens=32000).
const COMPACT_MAX_OUTPUT_TOKENS = 32_000;
const COMPACT_SUMMARY_RETRY_DELAY_MS = 2_000;

const EMPTY_INJECTIONS: InjectionQueue = {
  drain: () => [],
  peek: () => [],
  push: () => {},
};

/** Fold the compact directive into the last user message (ref wire layout). */
export function appendCompactDirective(messages: Message[], directive: string): Message[] {
  const block = { type: "text" as const, text: directive };
  if (messages.length === 0) {
    return [{ role: "user", content: [block] }];
  }
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    return [...messages.slice(0, -1), { ...last, content: [...last.content, block] }];
  }
  return [...messages, { role: "user", content: [block] }];
}

function emptyHarness(): ComposedHarness {
  return { layers: [], combined: "", systemBlocks: [], userPrepend: [], midSystemPromotion: "off" };
}

function resolveSummaryHarness(
  ctx: RequestContext,
  messages: Message[],
  harness?: ComposedHarness,
): ComposedHarness {
  if (harness) return harness;
  const cached = getAssembledTurn(ctx.sessionId);
  if (cached?.harness) return cached.harness;
  // Rebuild the real agent system so the summary request shares the conversation
  // prompt-cache prefix. Never invent a summarizer-specific system prompt.
  try {
    const provider = providers.get(ctx.provider);
    return assembleProviderTurn({
      ctx,
      provider,
      messages,
      injections: EMPTY_INJECTIONS,
      config: resolveConfig(ctx.cwd),
      currentDate: currentLocalISODate(),
    }).harness;
  } catch {
    // Test fakes / incomplete providers: compose with an empty harness rather
    // than inventing a summarizer-specific system string.
    return emptyHarness();
  }
}

const MAX_PTL_RETRIES = 3;
const PTL_RETRY_FALLBACK_DROP_FRACTION = 0.2;
const PTL_PATTERNS = [/prompt is too long/i, /context length/i, /maximum context/i, /HTTP 400/i];
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

function gapFrom(actualRaw: string | undefined, limitRaw: string | undefined): number | undefined {
  const actual = Number.parseInt(actualRaw ?? "", 10);
  const limit = Number.parseInt(limitRaw ?? "", 10);
  if (!Number.isFinite(actual) || !Number.isFinite(limit)) return undefined;
  const gap = actual - limit;
  return gap > 0 ? gap : undefined;
}

export function parsePtlTokenGap(msg: string): number | undefined {
  const anthropic = msg.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (anthropic) return gapFrom(anthropic[1], anthropic[2]);
  const openaiCtx = msg.match(
    /maximum context length is\s*(\d+)\s*tokens?.*?resulted in\s*(\d+)\s*tokens?/is,
  );
  if (openaiCtx) return gapFrom(openaiCtx[2], openaiCtx[1]);
  const openaiInput = msg.match(/your input of\s*(\d+)\s*tokens?\s*exceeds.*?(\d+)\s*token/is);
  if (openaiInput) return gapFrom(openaiInput[1], openaiInput[2]);
  const googleInput = msg.match(/input token count\s*\((\d+)\)\s*exceeds.*?\((\d+)\)/is);
  if (googleInput) return gapFrom(googleInput[1], googleInput[2]);
  return undefined;
}

export const PTL_RETRY_MARKER_TEXT = PTL_RETRY_MARKER;

function stripLeadingPtlMarker(messages: Message[]): Message[] {
  const head = messages[0];
  if (
    head &&
    head.role === "user" &&
    head.content.length === 1 &&
    head.content[0]?.type === "text" &&
    head.content[0].text === PTL_RETRY_MARKER
  ) {
    return messages.slice(1);
  }
  return messages;
}

function ensureUserLeading(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const first = messages[0];
  if (first?.role === "assistant") {
    return [{ role: "user", content: [{ type: "text", text: PTL_RETRY_MARKER }] }, ...messages];
  }
  return messages;
}

export interface SummarizeResult {
  summary: string;
  droppedMessages: number;
  preTokens: number;
}

export async function summarizeConversation(
  ctx: RequestContext,
  messages: Message[],
  tools: ProviderToolDeclaration[],
  customInstructions?: string,
  onEvent?: (ev: ProviderEvent) => void,
  harness?: ComposedHarness,
): Promise<SummarizeResult> {
  try {
    return await summarizeConversationAttempt(
      ctx,
      messages,
      tools,
      customInstructions,
      onEvent,
      harness,
    );
  } catch (err) {
    if (
      isCancellationError(err, ctx.abortSignal) ||
      err instanceof QuotaExhaustedError ||
      err instanceof CompactRefusalError
    )
      throw err;
    await waitForSummaryRetry(ctx.abortSignal);
    return summarizeConversationAttempt(ctx, messages, tools, customInstructions, onEvent, harness);
  }
}

async function summarizeConversationAttempt(
  ctx: RequestContext,
  messages: Message[],
  tools: ProviderToolDeclaration[],
  customInstructions?: string,
  onEvent?: (ev: ProviderEvent) => void,
  harnessOverride?: ComposedHarness,
): Promise<SummarizeResult> {
  const provider = providers.get(ctx.provider);
  // Keep the conversation envelope (thinking/effort/agentic) so the summary
  // request reuses the same cached prefix as a normal turn. The compact
  // request sends thinking enabled+summarized — never disableThinking.
  const compactPrompt = buildCompactSummaryPrompt(customInstructions);
  const harness = resolveSummaryHarness(ctx, messages, harnessOverride);

  const preTokens = estimateConversationTokens(messages);
  let working = dropImageBlocksFromMessages(messages);
  let dropped = 0;
  let lastTokenGap: number | undefined;

  for (let attempt = 0; attempt <= MAX_PTL_RETRIES; attempt++) {
    try {
      // Fold the directive into the last user content array (not a new message)
      // so the prefix through the last assistant remains a prompt-cache hit.
      const composed = provider.composeMessages(
        harness,
        sanitizeMessages(appendCompactDirective(working, compactPrompt)),
      );
      const withCache = provider.applyTrailingCacheControl
        ? provider.applyTrailingCacheControl(composed)
        : composed;
      const body = clampSummaryRequest(provider.translateRequest(ctx, withCache, tools));
      let text = "";
      let streamError: string | null = null;
      for await (const ev of streamWithRetry(ctx, provider, body)) {
        if (onEvent) onEvent(ev);
        if (ev.kind === "text_delta") text += ev.text;
        if (ev.kind === "stream_reset") {
          text = "";
          streamError = null;
        }
        if (ev.kind === "error") streamError = ev.error;
        if (ev.kind === "quota_exhausted") {
          throw new QuotaExhaustedError({
            provider: ev.provider,
            model: ev.model,
            resetEpochMs: ev.resetEpochMs,
            message: ev.message,
          });
        }
        if (ev.kind === "message_stop") {
          if (ev.stop_reason === "refusal") throw new CompactRefusalError(ev.refusal);
          if (ev.stop_reason === "cancelled") {
            const cancellation = new Error("compaction cancelled");
            cancellation.name = "AbortError";
            throw cancellation;
          }
          break;
        }
      }
      if (text.trim().length === 0) {
        if (streamError !== null) throw new CompactStreamError(streamError);
        throw new EmptyCompactSummaryError();
      }
      return { summary: text, droppedMessages: dropped, preTokens };
    } catch (err) {
      const isPtl = isContextOverflowError(err);
      const retryable = isPtl || isRetryableStreamError(err);
      if (!retryable || attempt >= MAX_PTL_RETRIES) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err ?? "");
      const tokenGap = isPtl ? parsePtlTokenGap(errMsg) : undefined;
      if (tokenGap !== undefined) lastTokenGap = tokenGap;
      const stripped = stripLeadingPtlMarker(working);
      const groups = groupByApiRound(stripped);
      const groupCount = groups.length;
      let groupsToDrop: number;
      if (tokenGap !== undefined) {
        let acc = 0;
        groupsToDrop = 0;
        for (const g of groups) {
          acc += estimateConversationTokens(g);
          groupsToDrop += 1;
          if (acc >= tokenGap) break;
        }
      } else {
        groupsToDrop = Math.max(1, Math.floor(groupCount * PTL_RETRY_FALLBACK_DROP_FRACTION));
      }
      groupsToDrop = Math.min(groupsToDrop, Math.max(0, groupCount - 1));
      if (groupsToDrop < 1) {
        const cleared = clearOldestToolResultsInSingleRound(stripped);
        if (!cleared) throw new CompactPromptTooLongError(lastTokenGap);
        working = ensureUserLeading(cleared);
        continue;
      }
      const next = trimHeadGroupsByCount(stripped, groupsToDrop);
      if (next.droppedGroups === 0) throw new CompactPromptTooLongError(lastTokenGap);
      working = ensureUserLeading(next.messages);
      dropped += next.droppedMessages;
    }
  }
  throw new CompactPromptTooLongError(lastTokenGap);
}

function isCancellationError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "aborted";
}

async function waitForSummaryRetry(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, COMPACT_SUMMARY_RETRY_DELAY_MS);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clampSummaryRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const next = { ...body };
  if (typeof next.max_tokens === "number") {
    next.max_tokens = Math.min(next.max_tokens, COMPACT_MAX_OUTPUT_TOKENS);
  }
  // Preserve thinking (enabled + display:"summarized" from the model envelope).
  // Disabling it here was the other half of the prompt-cache bust.
  return next;
}

function clearOldestToolResultsInSingleRound(messages: Message[]): Message[] | null {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") ids.push(b.id);
    }
  }
  if (ids.length === 0) return null;
  const keep = new Set(ids.slice(-1));
  const clear = new Set(ids.filter((id) => !keep.has(id)));
  if (clear.size === 0) return null;
  let touched = false;
  const next = messages.map((m) => {
    if (m.role !== "user") return m;
    const content = m.content.map((b) => {
      if (b.type !== "tool_result" || !clear.has(b.tool_use_id)) return b;
      const text = typeof b.content === "string" ? b.content : "";
      if (text === MICRO_COMPACT_CLEARED_MESSAGE) return b;
      touched = true;
      return {
        type: "tool_result" as const,
        tool_use_id: b.tool_use_id,
        content: MICRO_COMPACT_CLEARED_MESSAGE,
        ...(b.is_error ? { is_error: true } : {}),
      };
    });
    return { ...m, content };
  });
  return touched ? next : null;
}

function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return PTL_PATTERNS.some((p) => p.test(msg));
}

function dropImageBlocksFromMessages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const next = m.content.map((b) => {
      if (b.type === "image") return { type: "text" as const, text: "[image]" };
      return b;
    });
    return { ...m, content: next };
  });
}

const STREAM_RETRYABLE_PATTERNS = [
  /server had an error/i,
  /api_error/i,
  /HTTP 5\d\d/i,
  /overloaded/i,
  /service.unavailable/i,
];

function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof CompactStreamError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return STREAM_RETRYABLE_PATTERNS.some((p) => p.test(msg));
}
