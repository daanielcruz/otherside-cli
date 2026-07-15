import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/partial-json.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { usageFromOpenAi } from "@/engine/providers/_shared/usage.ts";
import { lowestReasoningEffort, modelSupportsReasoning } from "@/engine/providers/xai/models.ts";
import { isEncryptedReasoningRejected } from "@/engine/providers/xai/reasoning-state.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { toolResultText } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// xAI's CLI chat proxy speaks the OpenAI Responses protocol. Input items are
// `{type:"message", role, content}` (content is a plain string for text, an
// array of input_text/input_image parts when a user turn carries images), plus
// function_call / function_call_output / reasoning items. store:false is paired
// with include:["reasoning.encrypted_content"], so encrypted reasoning must be
// echoed back across turns (bound to the credential + model that produced it).

interface GrokInputItem {
  type?: string;
  role?: string;
  [k: string]: unknown;
}

interface GrokFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
}

interface GrokHostedTool {
  type: string;
}

type GrokTool = GrokFunctionTool | GrokHostedTool;

interface HarnessToolDecl {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

const EMPTY_SCHEMA = { type: "object", properties: {} };
const REASONING_SUMMARY = "concise";
const WEB_SEARCH_TOOL_NAME = "WebSearch";

// Web search rides as the server-executed hosted tool (mirrors the grok-cli
// wire and the codex web_search path) rather than a client function, so the
// proxy runs the search inline and streams back web_search_call items.
function toolsToGrok(tools: unknown[]): GrokTool[] {
  const out: GrokTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const decl = t as HarnessToolDecl;
    if (typeof decl.name !== "string" || decl.name.length === 0) continue;
    if (decl.name === WEB_SEARCH_TOOL_NAME) continue;
    const def: GrokFunctionTool = {
      type: "function",
      name: decl.name,
      parameters: decl.input_schema ?? EMPTY_SCHEMA,
    };
    if (typeof decl.description === "string") def.description = decl.description;
    out.push(def);
  }
  // Only agent turns carry the toolset; keep bare aux turns (e.g. title
  // generation) free of the hosted search, matching the grok-cli wire.
  if (out.length > 0) out.push({ type: "web_search" });
  return out;
}

function collectWebSearchCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === WEB_SEARCH_TOOL_NAME) ids.add(b.id);
    }
  }
  return ids;
}

function blockToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toolResultToGrok(r: Extract<ContentBlock, { type: "tool_result" }>): GrokInputItem {
  return {
    type: "function_call_output",
    call_id: r.tool_use_id,
    output: toolResultText(r.content),
  };
}

function userMessageItem(blocks: ContentBlock[]): GrokInputItem | null {
  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) {
    const text = blockToText(blocks);
    return text.length > 0 ? { type: "message", role: "user", content: text } : null;
  }
  const parts: GrokInputItem[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text.length > 0) {
      parts.push({ type: "input_text", text: b.text });
    } else if (b.type === "image") {
      parts.push({
        type: "input_image",
        image_url: `data:${b.source.media_type};base64,${b.source.data}`,
      });
    }
  }
  return parts.length > 0 ? { type: "message", role: "user", content: parts } : null;
}

function messagesToGrokInput(
  messages: Message[],
  currentModel: string,
  currentAccount: string | undefined,
  suppressEncryptedReasoning: boolean,
): GrokInputItem[] {
  const out: GrokInputItem[] = [];
  // Hosted web_search calls are replayed by the proxy via encrypted reasoning,
  // so their local echoes must not be re-sent as function_call items.
  const webSearchCallIds = collectWebSearchCallIds(messages);
  for (const m of messages) {
    if (m.role === "system") {
      const text = blockToText(m.content);
      if (text.length > 0) out.push({ type: "message", role: "system", content: text });
      continue;
    }
    if (m.role === "user") {
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        if (webSearchCallIds.has(r.tool_use_id)) continue;
        out.push(toolResultToGrok(r));
      }
      const userItem = userMessageItem(m.content);
      if (userItem) out.push(userItem);
      continue;
    }
    if (m.role === "assistant") {
      const reasoning = m.content.find(
        (b): b is Extract<ContentBlock, { type: "thinking" }> =>
          b.type === "thinking" && typeof b.signature === "string" && b.signature.length > 0,
      );
      // Encrypted reasoning is bound to the credential + model that produced it;
      // replaying it under another account/model is rejected by the proxy.
      const sameAccount = sameAccountFingerprint(m.producedAccount, currentAccount);
      if (
        reasoning?.signature &&
        m.producedModel === currentModel &&
        sameAccount &&
        !suppressEncryptedReasoning
      ) {
        const summary =
          reasoning.text.length > 0 ? [{ type: "summary_text", text: reasoning.text }] : [];
        out.push({ type: "reasoning", summary, encrypted_content: reasoning.signature });
      }
      const text = blockToText(m.content);
      if (text.length > 0) out.push({ type: "message", role: "assistant", content: text });
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      for (const tu of toolUses) {
        if (tu.name === WEB_SEARCH_TOOL_NAME) continue;
        out.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {}),
          status: "completed",
        });
      }
      continue;
    }
    if (m.role === "tool") {
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        if (webSearchCallIds.has(r.tool_use_id)) continue;
        out.push(toolResultToGrok(r));
      }
    }
  }
  return out;
}

// xAI reasoning models accept none/low/medium/high. Higher otherside tiers fold
// down to high; disableThinking maps to "none" which switches reasoning off
// entirely (grok-4.3+); a null effort omits the knob so the model keeps its
// default. See @ai-sdk/xai reasoningEffort + the captured grok-cli reasoning obj.
function reasoningEffortFor(ctx: RequestContext): "none" | "low" | "medium" | "high" | null {
  if (ctx.disableThinking) return "none";
  switch (ctx.effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return null;
  }
}

export function translateRequestGrok(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const grokTools = toolsToGrok(tools);

  // "Thinking off" (disableThinking, aux one-shots) maps to the synthetic "none"
  // — but the chat proxy 400s `reasoning_effort: "none"` on grok-4.5, which has
  // no true off switch. Approximate off with the model's cheapest real effort
  // and drop the summary/include/replay: a minimal, always-valid reasoning body.
  const reasoningModel = modelSupportsReasoning(ctx.model);
  const requestedEffort = reasoningModel ? reasoningEffortFor(ctx) : null;
  const thinkingOff = requestedEffort === "none";
  const effort = thinkingOff ? lowestReasoningEffort(ctx.model) : requestedEffort;
  const fullThinking = reasoningModel && !thinkingOff;

  const body: Record<string, unknown> = {
    model: ctx.model,
    input: messagesToGrokInput(
      messages,
      ctx.model,
      accountFingerprint(ctx.provider),
      !fullThinking || isEncryptedReasoningRejected(ctx.sessionId),
    ),
    store: false,
    stream: true,
  };

  if (reasoningModel) {
    if (fullThinking) {
      // Full reasoning rides alongside the concise summary the grok-cli requests
      // and round-trips the encrypted transcript across turns.
      const reasoning: Record<string, unknown> = { summary: REASONING_SUMMARY };
      if (effort) reasoning.effort = effort;
      body.reasoning = reasoning;
      body.include = ["reasoning.encrypted_content"];
    } else if (effort) {
      // Minimized thinking: just the cheapest effort, no summary/include.
      body.reasoning = { effort };
    }
  }

  if (grokTools.length > 0) {
    body.tools = grokTools;
    body.tool_choice = "auto";
  }
  return body;
}

interface GrokToolBuf {
  id: string;
  name: string;
  buffer: string;
}

interface GrokWebSearchStart {
  startedAt: number;
  query: string;
  url?: string;
  pattern?: string;
  actionType: string;
}

function webSearchActionFields(action: Record<string, unknown>): {
  actionType: string;
  query: string;
  url?: string;
  pattern?: string;
} {
  const actionType = String(action.type ?? "");
  if (actionType === "open_page") {
    const url = typeof action.url === "string" ? action.url : "";
    return { actionType, query: url, url };
  }
  if (actionType === "find_in_page") {
    const url = typeof action.url === "string" ? action.url : "";
    const pattern = typeof action.pattern === "string" ? action.pattern : "";
    return { actionType, query: pattern, url, pattern };
  }
  let query = typeof action.query === "string" ? action.query : "";
  if (!query && Array.isArray(action.queries)) {
    const arr = action.queries.filter((x): x is string => typeof x === "string");
    if (arr[0]) query = arr.length > 1 ? `${arr[0]} ...` : arr[0];
  }
  return { actionType, query };
}

export async function* translateResponseGrok(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const tools = new Map<string, GrokToolBuf>();
  const webSearches = new Map<string, GrokWebSearchStart>();
  let started = false;
  let sawTool = false;
  let sawTerminal = false;
  let reasoningSummaryPartsSeen = 0;
  const itemSawText = new Set<string>();
  const itemSawReasoning = new Set<string>();

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
      case "response.created":
      case "response.in_progress": {
        if (!started) {
          started = true;
          yield { kind: "message_start" };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const text = typeof data.delta === "string" ? data.delta : "";
        if (text) {
          const itemId = String(data.item_id ?? "");
          if (itemId) itemSawReasoning.add(itemId);
          yield { kind: "thinking_delta", text };
        }
        break;
      }
      case "response.reasoning_summary_part.added": {
        if (reasoningSummaryPartsSeen > 0) yield { kind: "thinking_delta", text: "\n\n" };
        reasoningSummaryPartsSeen++;
        break;
      }
      case "response.reasoning_summary_text.done":
      case "response.reasoning_summary_part.done":
      case "response.reasoning_text.done":
      case "response.function_call_arguments.done":
        break;
      case "response.output_item.added": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        const itype = String(item.type ?? "");
        if (itype === "function_call") {
          const callId = String(item.call_id ?? "");
          const itemId = String(item.id ?? "") || callId;
          const name = String(item.name ?? "");
          tools.set(itemId, { id: callId, name, buffer: "" });
          sawTool = true;
          yield { kind: "tool_call_start", id: callId, name };
        } else if (itype === "web_search_call") {
          const id = String(item.id ?? "") || "web_search";
          const fields = webSearchActionFields((item.action ?? {}) as Record<string, unknown>);
          const start: GrokWebSearchStart = {
            startedAt: Date.now(),
            query: fields.query,
            actionType: fields.actionType,
          };
          if (fields.url !== undefined) start.url = fields.url;
          if (fields.pattern !== undefined) start.pattern = fields.pattern;
          webSearches.set(id, start);
          // Server-handled: the proxy resolves the search inline and the model
          // keeps generating in the same turn, so it is not a pending client
          // tool call — leaving sawTool alone keeps stop_reason honest.
          yield { kind: "tool_call_start", id, name: WEB_SEARCH_TOOL_NAME };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const itemId = String(data.item_id ?? data.call_id ?? "");
        const partial = typeof data.delta === "string" ? data.delta : "";
        const t = tools.get(itemId);
        if (t && partial) {
          t.buffer += partial;
          yield { kind: "tool_call_input_delta", id: t.id, partial };
        }
        break;
      }
      case "response.output_text.delta": {
        const text = typeof data.delta === "string" ? data.delta : "";
        if (text) {
          const itemId = String(data.item_id ?? "");
          if (itemId) itemSawText.add(itemId);
          yield { kind: "text_delta", text };
        }
        break;
      }
      case "response.output_item.done": {
        const item = (data.item ?? {}) as Record<string, unknown>;
        const itype = String(item.type ?? "");
        if (itype === "message") {
          const itemId = String(item.id ?? "");
          if (!itemSawText.has(itemId)) {
            const content = Array.isArray(item.content) ? item.content : [];
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "output_text" && typeof b.text === "string" && b.text.length > 0) {
                yield { kind: "text_delta", text: b.text };
              }
            }
          }
          break;
        }
        if (itype === "function_call") {
          const itemId = String(item.id ?? "") || String(item.call_id ?? "");
          const t = tools.get(itemId);
          if (t) {
            let parsed: unknown = {};
            if (t.buffer.trim().length > 0) {
              const result = parseJsonWithPartialRecovery(t.buffer);
              parsed = result.ok ? result.value : t.buffer;
            }
            tools.delete(itemId);
            yield { kind: "tool_call_complete", id: t.id, name: t.name, input: parsed };
          } else {
            const callId = String(item.call_id ?? "") || String(item.id ?? "");
            const name = String(item.name ?? "");
            const rawArgs = typeof item.arguments === "string" ? item.arguments : "";
            let parsed: unknown = {};
            if (rawArgs.trim().length > 0) {
              const result = parseJsonWithPartialRecovery(rawArgs);
              parsed = result.ok ? result.value : rawArgs;
            }
            sawTool = true;
            yield { kind: "tool_call_start", id: callId, name };
            yield { kind: "tool_call_complete", id: callId, name, input: parsed };
          }
        } else if (itype === "web_search_call") {
          const id = String(item.id ?? "") || "web_search";
          const start = webSearches.get(id);
          const elapsed = start ? Date.now() - start.startedAt : 0;
          const fields = webSearchActionFields((item.action ?? {}) as Record<string, unknown>);
          const actionType = fields.actionType || start?.actionType || "";
          const input: Record<string, unknown> = {
            elapsed_ms: elapsed,
            durationSeconds: elapsed / 1000,
          };
          if (actionType === "open_page") {
            input.url = fields.url || start?.url || "";
          } else if (actionType === "find_in_page") {
            input.url = fields.url || start?.url || "";
            input.pattern = fields.pattern || start?.pattern || "";
          } else {
            input.query = fields.query || start?.query || "";
          }
          webSearches.delete(id);
          yield {
            kind: "tool_call_complete",
            id,
            name: WEB_SEARCH_TOOL_NAME,
            input,
            serverHandled: true,
          };
        } else if (itype === "reasoning") {
          const itemId = String(item.id ?? "");
          if (itemId && !itemSawReasoning.has(itemId)) {
            const summary = Array.isArray(item.summary) ? item.summary : [];
            for (let i = 0; i < summary.length; i++) {
              const block = summary[i];
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "summary_text" && typeof b.text === "string" && b.text.length > 0) {
                if (i > 0) yield { kind: "thinking_delta", text: "\n\n" };
                yield { kind: "thinking_delta", text: b.text };
              }
            }
          }
          // store:false returns the reasoning under encrypted_content; carry it
          // as the thinking signature so the next turn can replay it.
          const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
          if (enc.length > 0) yield { kind: "thinking_signature", signature: enc };
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = usageFromOpenAi(response?.usage);
        if (usage) yield usage;
        sawTerminal = true;
        yield { kind: "message_stop", stop_reason: sawTool ? "tool_calls" : "stop" };
        break;
      }
      case "response.incomplete": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = usageFromOpenAi(response?.usage);
        if (usage) yield usage;
        const reason = (response?.incomplete_details as Record<string, unknown> | undefined)
          ?.reason;
        sawTerminal = true;
        yield { kind: "message_stop", stop_reason: typeof reason === "string" ? reason : "length" };
        break;
      }
      case "error":
      case "response.failed":
      case "response.error": {
        const errObj =
          ((data.response as Record<string, unknown> | undefined)?.error as
            | Record<string, unknown>
            | undefined) ?? (data.error as Record<string, unknown> | undefined);
        const rawBody = errObj ? JSON.stringify({ error: errObj }) : ev.data;
        throw streamErrorToHttpError({ provider: "xai/responses", rawBody });
      }
      case "response.cancelled": {
        sawTerminal = true;
        yield { kind: "message_stop", stop_reason: "cancelled" };
        break;
      }
      default:
        break;
    }
  }

  if (!sawTerminal) {
    throw streamErrorToHttpError({
      provider: "xai/responses",
      rawBody: JSON.stringify({
        error: { type: "api_error", message: "stream closed before response.completed" },
      }),
      fallbackStatus: 500,
    });
  }
}
