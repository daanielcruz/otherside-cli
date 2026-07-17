import {
  defaultEffortForModel,
  effortLevelsForModel,
  parseModelId,
} from "@/engine/model/catalog.ts";
import {
  modelSupportsContextManagement as anthropicModelSupportsContextManagement,
  isHaikuModel,
} from "@/engine/model/facts/model-family.ts";
import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { isAnthropicFamily } from "@/engine/providers/_shared/families.ts";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/partial-json.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { thinkingProvenance } from "@/engine/providers/_shared/thinking-provenance.ts";
import {
  ensureNonEmptyErrorContent,
  sanitizeToolResultContent,
} from "@/engine/providers/_shared/tool-result.ts";
import { usageFromAnthropic } from "@/engine/providers/_shared/usage.ts";
import { anthropicWireModelId } from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import {
  anthropicEnvelopeDefaults,
  maxOutputTokensForModel as anthropicMaxOutputTokensForModel,
} from "@/engine/providers/anthropic/envelope.ts";
import { anthropicUserIdMetadata } from "@/engine/providers/anthropic/metadata.ts";
import { isThinkingReplayRejected } from "@/engine/providers/anthropic/reasoning-state.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import {
  type ContentBlock,
  type Message,
  PDF_UNAVAILABLE_PLACEHOLDER,
} from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: AnthropicBlock[];
}

function isAnthropicShapeThinkingSignature(sig: string | undefined): sig is string {
  if (typeof sig !== "string") return false;
  if (sig.length < 400) return false;
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

interface BlockTranslateOpts {
  producedBy: ProviderId | undefined;
  producedModel: string | undefined;
  producedAccount: string | undefined;
  currentModel: string;
  currentAccount: string | undefined;
  target: ProviderId;
  suppressThinkingReplay: boolean;
}

function thinkingBlockToAnthropic(
  block: Extract<ContentBlock, { type: "thinking" }>,
  opts: BlockTranslateOpts,
): AnthropicBlock | null {
  // The API already rejected a replayed thinking block this session; every
  // rebuilt request drops thinking replay so the turn can proceed.
  if (opts.suppressThinkingReplay) return null;
  const produced = thinkingProvenance(block, opts);
  if (opts.target === "deepseek") {
    // Same rule as the anthropic branch below: a signed block replays only to
    // the provider + credential that produced it, and a missing signature is
    // never substituted with a fabricated empty one.
    if (produced.producedBy !== "deepseek") return null;
    if (!sameAccountFingerprint(produced.producedAccount, opts.currentAccount)) return null;
    if (typeof block.signature !== "string" || block.signature.length === 0) return null;
    return {
      type: "thinking",
      thinking: block.text,
      signature: block.signature,
    };
  }
  if (!isAnthropicFamily(produced.producedBy)) return null;
  // Signatures are bound to the credential that generated them, not the
  // model: replaying a block signed by another account is rejected with a
  // "thinking blocks cannot be modified" 400. Unstamped (legacy) blocks are
  // dropped because same-account provenance cannot be proven.
  if (!sameAccountFingerprint(produced.producedAccount, opts.currentAccount)) return null;
  if (!isAnthropicShapeThinkingSignature(block.signature)) return null;
  return { type: "thinking", thinking: block.text, signature: block.signature };
}

function anthropicToolResultContent(
  content: Extract<ContentBlock, { type: "tool_result" }>["content"],
  target: ProviderId,
): ReturnType<typeof sanitizeToolResultContent> {
  if (!Array.isArray(content)) return sanitizeToolResultContent(content);
  return content.map((part) => {
    if (part.type !== "pdf") {
      if (part.type === "image") {
        return {
          type: "image",
          source: {
            type: part.source.type,
            media_type: part.source.media_type,
            data: part.source.data,
          },
        };
      }
      return part;
    }
    if (target !== "anthropic") {
      return { type: "text", text: PDF_UNAVAILABLE_PLACEHOLDER };
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: part.source.data,
      },
    };
  });
}

function blockToAnthropic(block: ContentBlock, opts: BlockTranslateOpts): AnthropicBlock | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.cache_control ? { cache_control: block.cache_control } : {}),
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
        caller: { type: "direct" },
      };
    case "tool_result": {
      const resultContent = anthropicToolResultContent(block.content, opts.target);
      return {
        tool_use_id: block.tool_use_id,
        type: "tool_result",
        content: block.is_error ? ensureNonEmptyErrorContent(resultContent) : resultContent,
        ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}),
        ...(block.cache_control ? { cache_control: block.cache_control } : {}),
      };
    }
    case "thinking":
      return thinkingBlockToAnthropic(block, opts);
    case "image":
      return {
        type: "image",
        source: {
          type: block.source.type,
          media_type: block.source.media_type,
          data: block.source.data,
        },
      };
    default:
      return null;
  }
}

export function buildAnthropicMessages(
  messages: Message[],
  ctx: RequestContext,
): {
  system: AnthropicBlock[] | undefined;
  out: AnthropicMessage[];
} {
  const target = ctx.provider;
  // Derived fresh at request build (not threaded through ctx) so a credential
  // switch — even one made mid-turn by another client — gates the very next
  // request, and tier-routed ctx clones can never carry a stale fingerprint.
  const currentAccount = accountFingerprint(target);
  const suppressThinkingReplay = isThinkingReplayRejected(ctx.sessionId);
  const systemBlocks: AnthropicBlock[] = [];
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const textBlocks: AnthropicBlock[] = [];
      for (const b of msg.content) {
        if (b.type !== "text") continue;
        textBlocks.push({
          type: "text",
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        });
      }
      if (out.length === 0) systemBlocks.push(...textBlocks);
      else if (textBlocks.length > 0) out.push({ role: "system", content: textBlocks });
      continue;
    }
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const opts: BlockTranslateOpts = {
      producedBy: msg.producedBy,
      producedModel: msg.producedModel,
      producedAccount: msg.producedAccount,
      currentModel: ctx.model,
      currentAccount,
      target,
      suppressThinkingReplay,
    };
    const blocks = msg.content
      .map((block) => blockToAnthropic(block, opts))
      .filter((b): b is AnthropicBlock => b !== null);
    if (blocks.length === 0) continue;
    out.push({ role, content: blocks });
  }
  return { system: systemBlocks.length > 0 ? systemBlocks : undefined, out };
}

function stripCacheControlFromBlocks(blocks: AnthropicBlock[]): AnthropicBlock[] {
  return blocks.map(({ cache_control: _, ...rest }) => rest as AnthropicBlock);
}

function toWireSystemMessage(
  msg: AnthropicMessage,
): AnthropicMessage | { role: AnthropicMessage["role"]; content: string } {
  if (msg.role !== "system") return msg;
  const text = msg.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
  return { role: msg.role, content: text };
}

export function translateRequestAnthropic(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const parsed = parseModelId(ctx.model);
  const { system, out } = buildAnthropicMessages(messages, ctx);
  const envelope = anthropicEnvelopeDefaults();
  const isTitle = ctx.cacheRole === "title";

  const wireSystem = isTitle && system ? stripCacheControlFromBlocks(system) : system;
  const wireOut = (
    isTitle
      ? out.map((msg) => ({
          ...msg,
          content: stripCacheControlFromBlocks(msg.content),
        }))
      : out
  ).map(toWireSystemMessage);

  const body: Record<string, unknown> = {
    model: anthropicWireModelId(parsed.base, ctx.agentic !== false && !ctx.parentThreadId),
    messages: wireOut,
  };
  if (wireSystem && wireSystem.length > 0) body.system = wireSystem;
  if (tools && tools.length > 0) body.tools = tools;
  body.metadata = { user_id: anthropicUserIdMetadata(ctx.sessionId) };

  Object.assign(body, envelope);
  body.max_tokens = anthropicMaxOutputTokensForModel(parsed.base);
  applyAnthropicEffortEnvelope(
    body,
    parsed.base,
    ctx.provider,
    ctx.effort,
    ctx.disableThinking === true,
    ctx.suppressThinkingSummary === true,
    ctx.agentic !== false,
  );
  if (!anthropicModelSupportsContextManagement(parsed.base)) delete body.context_management;
  return body;
}

function applyAnthropicEffortEnvelope(
  body: Record<string, unknown>,
  model: string,
  provider: ProviderId,
  effort: EffortLevel | null,
  disableThinking: boolean,
  suppressThinkingSummary: boolean,
  agentic: boolean,
): void {
  const levels = effortLevelsForModel(model, provider);
  const selected = disableThinking ? null : (effort ?? defaultEffortForModel(model, provider));
  if (selected === null || levels.length === 0 || !levels.some((level) => level === selected)) {
    // Effortless agentic main turns (haiku) still include thinking behavior: the main turn carries an explicit budget (max_tokens - 1) plus context_management and no output_config key.
    if (!disableThinking && agentic && isHaikuModel(model)) {
      const maxTokens =
        typeof body.max_tokens === "number"
          ? body.max_tokens
          : anthropicMaxOutputTokensForModel(model);
      const budget = maxTokens - 1;
      body.thinking = {
        budget_tokens: budget,
        type: "enabled",
        ...(suppressThinkingSummary ? {} : { display: "summarized" }),
      };
      delete body.output_config;
      return;
    }
    delete body.thinking;
    delete body.context_management;
    stripAnthropicOutputEffort(body);
    return;
  }
  // Sub-agents/forks keep reasoning (effort + continuity) but drop the rendered
  // summary: omit the thinking `display` field so the API streams no summary
  // text. The main agent keeps display:"summarized" for visible summaries.
  if (suppressThinkingSummary) {
    const thinking = body.thinking;
    if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
      delete (thinking as Record<string, unknown>).display;
    }
  }
  const output = body.output_config;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    (output as Record<string, unknown>).effort = selected;
  }
}

function stripAnthropicOutputEffort(body: Record<string, unknown>): void {
  const output = body.output_config;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    delete (output as Record<string, unknown>).effort;
  }
}

interface AnthropicToolBlockState {
  id: string;
  name: string;
  buffer: string;
}

export async function* translateResponseAnthropic(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const tools = new Map<number, AnthropicToolBlockState>();
  let stopReason = "stop";
  let refusal: string | undefined;
  let messageStarted = false;

  for await (const ev of parseSse(raw)) {
    if (!ev.data) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventName = ev.event || (typeof data.type === "string" ? data.type : "");

    switch (eventName) {
      case "message_start": {
        const startMessage = data.message as Record<string, unknown> | undefined;
        if (!messageStarted) {
          messageStarted = true;
          const startId = typeof startMessage?.id === "string" ? startMessage.id : undefined;
          yield startId !== undefined
            ? { kind: "message_start", id: startId }
            : { kind: "message_start" };
        }
        const startUsage = usageFromAnthropic(startMessage?.usage);
        if (startUsage) yield startUsage;
        break;
      }
      case "content_block_start": {
        const block = data.content_block as Record<string, unknown> | undefined;
        const idx = typeof data.index === "number" ? data.index : -1;
        if (block && block.type === "tool_use") {
          const id = String(block.id ?? "");
          const name = String(block.name ?? "");
          tools.set(idx, { id, name, buffer: "" });
          yield { kind: "tool_call_start", id, name };
        }
        break;
      }
      case "content_block_delta": {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        const idx = typeof data.index === "number" ? data.index : -1;
        const dt = String(delta.type ?? "");
        if (dt === "text_delta") {
          const text = String(delta.text ?? "");
          if (text) yield { kind: "text_delta", text };
        } else if (dt === "thinking_delta") {
          const text = String(delta.thinking ?? "");
          if (text) yield { kind: "thinking_delta", text };
        } else if (dt === "signature_delta") {
          const signature = String(delta.signature ?? "");
          if (signature) yield { kind: "thinking_signature", signature };
        } else if (dt === "input_json_delta") {
          const partial = String(delta.partial_json ?? "");
          const tool = tools.get(idx);
          if (tool && partial) {
            tool.buffer += partial;
            yield { kind: "tool_call_input_delta", id: tool.id, partial };
          }
        }
        break;
      }
      case "content_block_stop": {
        const idx = typeof data.index === "number" ? data.index : -1;
        const tool = tools.get(idx);
        if (tool) {
          let parsed: unknown = {};
          if (tool.buffer.trim().length > 0) {
            const result = parseJsonWithPartialRecovery(tool.buffer);
            parsed = result.ok ? result.value : tool.buffer;
          }
          tools.delete(idx);
          yield {
            kind: "tool_call_complete",
            id: tool.id,
            name: tool.name,
            input: parsed,
          };
        }
        break;
      }
      case "message_delta": {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.stop_reason === "string") {
          stopReason = mapAnthropicStopReason(delta.stop_reason);
        }
        const details = delta?.stop_details as Record<string, unknown> | undefined;
        if (details?.type === "refusal" && typeof details.explanation === "string") {
          refusal = details.explanation;
        }
        const usage = usageFromAnthropic(data.usage);
        if (usage) yield usage;
        break;
      }
      case "message_stop": {
        yield refusal !== undefined
          ? { kind: "message_stop", stop_reason: stopReason, refusal }
          : { kind: "message_stop", stop_reason: stopReason };
        return;
      }
      case "error": {
        throw streamErrorToHttpError({
          provider: "/v1/messages",
          rawBody: ev.data,
        });
      }
      default:
        break;
    }
  }
}

function mapAnthropicStopReason(r: string): string {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return "stop";
  }
}
