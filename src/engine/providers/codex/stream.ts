import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/streaming-json-repair.ts";
import { usageFromOpenAi } from "@/engine/providers/_shared/usage.ts";
import { parseCodexUsage } from "@/engine/providers/codex/usage.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";

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
