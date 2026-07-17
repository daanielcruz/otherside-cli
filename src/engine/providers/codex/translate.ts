import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/partial-json.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { thinkingProvenance } from "@/engine/providers/_shared/thinking-provenance.ts";
import { usageFromOpenAi } from "@/engine/providers/_shared/usage.ts";
import { buildCodexEnvelope } from "@/engine/providers/codex/envelope.ts";
import { MODELS } from "@/engine/providers/codex/models.ts";
import { isEncryptedReasoningRejected } from "@/engine/providers/codex/transport/state.ts";
import { parseCodexUsage } from "@/engine/providers/codex/usage.ts";
import CODEX_PREAMBLE from "@/harness/providers/codex/preamble.md" with { type: "text" };
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { toolResultText } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface CodexInputItem {
  type: string;
  [k: string]: unknown;
}

interface CodexFunctionTool {
  type: "function";
  name: string;
  description?: string;
  strict: boolean;
  parameters: unknown;
}

interface CodexWebSearchTool {
  type: "web_search";
  external_web_access?: boolean;
  search_content_types?: string[];
}

interface CodexFreeformTool {
  type: "custom";
  name: string;
  description: string;
  format: { type: "grammar"; syntax: "lark"; definition: string };
}

type CodexTool = CodexFunctionTool | CodexWebSearchTool | CodexFreeformTool;

const WEB_SEARCH_TOOL_NAME = "WebSearch";

interface HarnessToolDecl {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

const CODEX_CALL_ID_MAX = 64;
const CODEX_REASONING_PLACEHOLDER = "<!-- -->";

function stripCodexReasoningPlaceholder(text: string): string {
  return text.replaceAll(CODEX_REASONING_PLACEHOLDER, "");
}

function sanitizeCodexReasoningDelta(text: string, carry: string): { text: string; carry: string } {
  const stripped = stripCodexReasoningPlaceholder(`${carry}${text}`);
  for (
    let length = Math.min(CODEX_REASONING_PLACEHOLDER.length - 1, stripped.length);
    length > 0;
    length--
  ) {
    const suffix = stripped.slice(-length);
    if (CODEX_REASONING_PLACEHOLDER.startsWith(suffix)) {
      return { text: stripped.slice(0, -length), carry: suffix };
    }
  }
  return { text: stripped, carry: "" };
}

function codexCallId(id: string): string {
  if (id.length <= CODEX_CALL_ID_MAX) return id;
  let hash = 5381;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
  const suffix = hash.toString(16).padStart(8, "0");
  return `${id.slice(0, CODEX_CALL_ID_MAX - suffix.length - 1)}_${suffix}`;
}

function toolsToCodex(tools: unknown[], useResponsesLite = false): CodexTool[] {
  const out: CodexTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const decl = t as HarnessToolDecl;
    if (typeof decl.name !== "string" || decl.name.length === 0) continue;
    if (decl.name === WEB_SEARCH_TOOL_NAME && !useResponsesLite) continue;
    const def: CodexFunctionTool = {
      type: "function",
      name: decl.name,
      strict: false,
      parameters: decl.input_schema ?? EMPTY_SCHEMA,
    };
    if (typeof decl.description === "string") def.description = decl.description;
    out.push(def);
  }
  if (!useResponsesLite) {
    out.push({
      type: "web_search",
      external_web_access: true,
      search_content_types: ["text", "image"],
    });
  }
  return out;
}

function extractInstructions(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return null;
}

function blockToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function messagesToInput(
  messages: Message[],
  currentModel: string,
  currentAccount: string | undefined,
  suppressEncryptedReasoning: boolean,
  useResponsesLite = false,
): CodexInputItem[] {
  const out: CodexInputItem[] = [];
  // Hosted web_search calls are replayed by the server, so their local echoes
  // must be dropped; Lite runs WebSearch as a client function, and dropping the
  // results would re-trigger the search on every turn.
  const webSearchCallIds = useResponsesLite ? new Set<string>() : collectWebSearchCallIds(messages);
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const parts: CodexInputItem[] = [];
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        if (webSearchCallIds.has(r.tool_use_id)) continue;
        out.push(toolResultToCodex(r));
      }
      for (const b of m.content) {
        if (b.type === "text" && b.text.length > 0) {
          parts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${b.source.media_type};base64,${b.source.data}`,
          });
        }
      }
      if (parts.length > 0) {
        out.push({ type: "message", role: "user", content: parts });
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = blockToText(m.content);
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      // Encrypted reasoning is bound to the credential that produced it;
      // replaying it under another account is rejected by the endpoint.
      // Provenance is judged per block — a rebuilt message can carry blocks
      // from several producers.
      const reasoning = m.content.find((b): b is Extract<ContentBlock, { type: "thinking" }> => {
        if (b.type !== "thinking") return false;
        if (typeof b.signature !== "string" || b.signature.length === 0) return false;
        const produced = thinkingProvenance(b, m);
        const producedByCodex =
          produced.producedBy === "codex" ||
          (!!produced.producedModel && MODELS.some((model) => model.id === produced.producedModel));
        return producedByCodex && sameAccountFingerprint(produced.producedAccount, currentAccount);
      });
      if (reasoning?.signature && !suppressEncryptedReasoning) {
        const summary =
          reasoning.text.length > 0 ? [{ type: "summary_text", text: reasoning.text }] : [];
        out.push({ type: "reasoning", summary, encrypted_content: reasoning.signature });
      }
      if (text.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tu of toolUses) {
        if (tu.name === WEB_SEARCH_TOOL_NAME && !useResponsesLite) {
          continue;
        }
        out.push({
          type: "function_call",
          call_id: codexCallId(tu.id),
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
        out.push(toolResultToCodex(r));
      }
    }
  }
  return out;
}

function collectWebSearchCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === WEB_SEARCH_TOOL_NAME) {
        ids.add(b.id);
      }
    }
  }
  return ids;
}

const CODEX_OUTPUT_CONTENT_TYPES = new Set([
  "input_text",
  "input_image",
  "output_text",
  "refusal",
  "input_file",
  "computer_screenshot",
  "summary_text",
]);

function isCodexOutputContentArray(parsed: unknown): boolean {
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (v) =>
        !!v &&
        typeof v === "object" &&
        typeof (v as { type?: unknown }).type === "string" &&
        CODEX_OUTPUT_CONTENT_TYPES.has((v as { type: string }).type),
    )
  );
}

function toolResultToCodex(r: Extract<ContentBlock, { type: "tool_result" }>): CodexInputItem {
  // Binary blocks must ride as content items — flattening to text would strip
  // their bytes into a placeholder before they reach the wire.
  if (Array.isArray(r.content) && r.content.some((b) => b.type === "image" || b.type === "pdf")) {
    const items: CodexInputItem[] = [];
    for (const b of r.content) {
      if (b.type === "text" && b.text.length > 0) {
        items.push({ type: "input_text", text: b.text });
      } else if (b.type === "image") {
        items.push({
          type: "input_image",
          image_url: `data:${b.source.media_type};base64,${b.source.data}`,
        });
      } else if (b.type === "pdf") {
        items.push({
          type: "input_file",
          filename: b.filename,
          file_data: `data:application/pdf;base64,${b.source.data}`,
        });
      }
    }
    return { type: "function_call_output", call_id: codexCallId(r.tool_use_id), output: items };
  }
  const text = toolResultText(r.content);
  let outputValue: unknown = text;
  try {
    const parsed = JSON.parse(text);
    if (isCodexOutputContentArray(parsed)) {
      outputValue = parsed;
    }
  } catch {}
  return { type: "function_call_output", call_id: codexCallId(r.tool_use_id), output: outputValue };
}

// /responses accepts "max" even though its invalid_value error message still
// lists only none..xhigh (proven by live probe).
function effortFromCtx(effort: string | null): string | null {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return null;
  }
}

const CACHE_KEY_SUFFIX_TITLE = ":title";
const CACHE_KEY_SUFFIX_FORK = ":fork";

function promptCacheKeyForCtx(ctx: RequestContext): string {
  if (ctx.cacheRole === "title") return `${ctx.sessionId}${CACHE_KEY_SUFFIX_TITLE}`;
  if (ctx.subagentLabel) {
    const forkSuffix = ctx.agentOwnerId
      ? `${CACHE_KEY_SUFFIX_FORK}:${ctx.agentOwnerId}`
      : CACHE_KEY_SUFFIX_FORK;
    return `${ctx.sessionId}${forkSuffix}`;
  }
  return ctx.sessionId;
}

export interface CodexBodyExtras {
  serviceTier?: string | undefined;
}

export function translateRequestCodex(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
  extras: CodexBodyExtras = {},
): unknown {
  const modelEntry = MODELS.find((m) => m.id === ctx.model);
  const modelAugment = modelEntry?.augment;
  const useResponsesLite = modelAugment?.useResponsesLite ?? false;

  const callerInstructions = extractInstructions(messages);
  const instructions =
    ctx.provider === "codex" && callerInstructions
      ? `${CODEX_PREAMBLE}\n\n${callerInstructions}`
      : callerInstructions;
  const codexTools = toolsToCodex(tools, useResponsesLite);

  let input = messagesToInput(
    messages,
    ctx.model,
    accountFingerprint(ctx.provider),
    isEncryptedReasoningRejected(ctx.sessionId),
    useResponsesLite,
  );

  if (useResponsesLite) {
    const prefix: CodexInputItem[] = [
      {
        type: "additional_tools",
        role: "developer",
        tools: codexTools,
      },
    ];
    if (instructions && instructions.length > 0) {
      prefix.push({
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: instructions,
          },
        ],
      });
    }
    input = [...prefix, ...input];
  }

  return buildCodexEnvelope({
    ctx,
    instructions: useResponsesLite ? null : instructions,
    input,
    tools: useResponsesLite ? undefined : codexTools,
    promptCacheKey: promptCacheKeyForCtx(ctx),
    effort: effortFromCtx(ctx.effort),
    serviceTier: extras.serviceTier,
    useResponsesLite,
    serviceTiers: modelAugment?.serviceTiers,
    defaultVerbosity: modelAugment?.defaultVerbosity,
  });
}

interface CodexToolBuf {
  id: string;
  name: string;
  buffer: string;
  kind: "function" | "custom";
}

interface CodexWebSearchStart {
  startedAt: number;
  query: string;
  url?: string;
  pattern?: string;
  actionType: string;
}

export async function* translateResponseCodex(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const tools = new Map<string, CodexToolBuf>();
  const webSearches = new Map<string, CodexWebSearchStart>();
  let stopReason = "stop";
  let started = false;
  let sawTool = false;
  let sawTerminal = false;
  let reasoningSummaryPartsSeen = 0;
  let reasoningPlaceholderCarry = "";
  let reasoningPlaceholderCarryItemId = "";
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
      case "codex.rate_limits": {
        const usage = parseCodexUsage(data);
        if (usage) yield { kind: "usage_limits", provider: "codex", usage };
        break;
      }
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
        const rawText = typeof data.delta === "string" ? data.delta : "";
        const itemId = String(data.item_id ?? "");
        if (itemId && itemId !== reasoningPlaceholderCarryItemId) {
          reasoningPlaceholderCarry = "";
          reasoningPlaceholderCarryItemId = itemId;
        }
        const { text, carry } = sanitizeCodexReasoningDelta(rawText, reasoningPlaceholderCarry);
        reasoningPlaceholderCarry = carry;
        if (itemId) itemSawReasoning.add(itemId);
        if (text) yield { kind: "thinking_delta", text };
        break;
      }
      case "response.reasoning_summary_part.added": {
        reasoningPlaceholderCarry = "";
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
          tools.set(itemId, { id: callId, name, buffer: "", kind: "function" });
          sawTool = true;
          yield { kind: "tool_call_start", id: callId, name };
        } else if (itype === "web_search_call") {
          const id = String(item.id ?? "") || "web_search";
          const action = (item.action ?? {}) as Record<string, unknown>;
          const actionType = String(action.type ?? "");
          let query = "";
          let url: string | undefined;
          let pattern: string | undefined;
          if (actionType === "search") {
            query = typeof action.query === "string" ? action.query : "";
            if (!query && Array.isArray(action.queries)) {
              const arr = action.queries.filter((x): x is string => typeof x === "string");
              if (arr[0]) query = arr.length > 1 ? `${arr[0]} ...` : arr[0];
            }
          } else if (actionType === "open_page") {
            url = typeof action.url === "string" ? action.url : "";
            query = url ?? "";
          } else if (actionType === "find_in_page") {
            url = typeof action.url === "string" ? action.url : "";
            pattern = typeof action.pattern === "string" ? action.pattern : "";
            query = pattern ?? "";
          }
          const start: CodexWebSearchStart = { startedAt: Date.now(), query, actionType };
          if (url !== undefined) start.url = url;
          if (pattern !== undefined) start.pattern = pattern;
          webSearches.set(id, start);
          yield { kind: "tool_call_start", id, name: "WebSearch" };
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
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
            let parsed: unknown = null;
            let success = false;
            if (t.buffer.trim().length > 0) {
              const result = parseJsonWithPartialRecovery(t.buffer);
              if (result.ok) {
                parsed = result.value;
                success = true;
              }
            }
            if (!success) {
              const rawArgs = typeof item.arguments === "string" ? item.arguments : "";
              if (rawArgs.trim().length > 0) {
                const result = parseJsonWithPartialRecovery(rawArgs);
                if (result.ok) {
                  parsed = result.value;
                  success = true;
                }
              }
            }
            if (!success) {
              parsed = {};
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
          const action = (item.action ?? {}) as Record<string, unknown>;
          const actionType = String(action.type ?? start?.actionType ?? "");
          const input: Record<string, unknown> = {
            elapsed_ms: elapsed,
            durationSeconds: elapsed / 1000,
          };
          if (actionType === "search") {
            const q = (typeof action.query === "string" && action.query) || (start?.query ?? "");
            input.query = q;
          } else if (actionType === "open_page") {
            const url = (typeof action.url === "string" && action.url) || start?.url || "";
            input.url = url;
          } else if (actionType === "find_in_page") {
            const url = (typeof action.url === "string" && action.url) || start?.url || "";
            const pattern =
              (typeof action.pattern === "string" && action.pattern) || start?.pattern || "";
            input.url = url;
            input.pattern = pattern;
          }
          webSearches.delete(id);
          // Hosted web_search is resolved server-side and answered inline, so it
          // must not flip stopReason to "tool_calls" — that leaves no client call
          // to run and drives the turn loop into a malformed-tool-call retry.
          yield {
            kind: "tool_call_complete",
            id,
            name: "WebSearch",
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
                const text = stripCodexReasoningPlaceholder(b.text);
                if (i > 0) yield { kind: "thinking_delta", text: "\n\n" };
                if (text) yield { kind: "thinking_delta", text };
              }
            }
          }
          const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
          if (enc.length > 0) yield { kind: "thinking_signature", signature: enc };
        }
        break;
      }
      case "response.completed": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = usageFromOpenAi(response?.usage);
        if (usage) yield usage;
        stopReason = sawTool ? "tool_calls" : "stop";
        sawTerminal = true;
        yield { kind: "message_stop", stop_reason: stopReason };
        break;
      }
      case "response.incomplete": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = usageFromOpenAi(response?.usage);
        if (usage) yield usage;
        const reason = (response?.incomplete_details as Record<string, unknown> | undefined)
          ?.reason;
        sawTerminal = true;
        const incompleteReason = typeof reason === "string" ? reason : "length";
        throw streamErrorToHttpError({
          provider: "codex/responses",
          rawBody: JSON.stringify({
            error: {
              type: "api_error",
              message: `incomplete response: ${incompleteReason}`,
            },
          }),
          fallbackStatus: 500,
        });
      }
      case "error":
      case "response.failed":
      case "response.error": {
        const errObj =
          ((data.response as Record<string, unknown> | undefined)?.error as
            | Record<string, unknown>
            | undefined) ?? (data.error as Record<string, unknown> | undefined);
        const rawBody = errObj ? JSON.stringify({ error: errObj }) : ev.data;
        throw streamErrorToHttpError({ provider: "codex/responses", rawBody });
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
      provider: "codex/responses",
      rawBody: JSON.stringify({
        error: {
          type: "api_error",
          message: "stream closed before response.completed",
        },
      }),
      fallbackStatus: 500,
    });
  }
}
