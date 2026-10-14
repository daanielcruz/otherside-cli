import { ProviderHttpError, streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { usageFromAnthropic } from "@/engine/providers/_shared/usage.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { parseCloudEvent, record, string } from "./client.ts";
import { type CloudTool, cloudTools, MCP_SERVER_NAME } from "./mcp.ts";
import { CLOUD_DEFAULT_EFFORT, CLOUD_MODEL_ID } from "./model.ts";

const SYNTHETIC_ASSISTANT_ERROR_TYPES: ReadonlyMap<string, string> = new Map([
  ["authentication_failed", "authentication_error"],
  ["oauth_org_not_allowed", "permission_error"],
  ["billing_error", "insufficient_quota"],
  ["rate_limit", "rate_limit_error"],
  ["overloaded", "overloaded_error"],
  ["invalid_request", "invalid_request_error"],
  ["model_not_found", "invalid_request_error"],
  ["server_error", "api_error"],
  ["unknown", "unknown"],
  ["max_output_tokens", "max_output_tokens"],
  ["account_on_hold", "permission_error"],
  ["verification_required", "permission_error"],
  ["cloud_credential_error", "api_error"],
]);

export class CloudSyntheticAssistantError extends ProviderHttpError {
  constructor(code: string, diagnostic: string) {
    super(
      streamErrorToHttpError({
        provider: "anthropic-cloud",
        rawBody: JSON.stringify({
          type: "error",
          error: {
            type: SYNTHETIC_ASSISTANT_ERROR_TYPES.get(code) ?? code,
            code,
            message: diagnostic,
          },
        }),
      }),
    );
    this.message = diagnostic;
  }
}

export function cloudSyntheticAssistantError(
  payload: Record<string, unknown>,
): CloudSyntheticAssistantError | undefined {
  if (payload.type !== "assistant") return;
  const message = record(payload.message, "assistant message");
  if (message.model !== "<synthetic>") return;
  const code = typeof payload.error === "string" ? payload.error : "";
  if (payload.is_api_error_message !== true && !SYNTHETIC_ASSISTANT_ERROR_TYPES.has(code)) return;
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const texts: string[] = [];
  const content: unknown[] = message.content;
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      !("type" in block) ||
      block.type !== "text" ||
      !("text" in block) ||
      typeof block.text !== "string"
    )
      return;
    texts.push(block.text);
  }
  const text = texts.join("\n");
  if (!text.trim()) return;
  return new CloudSyntheticAssistantError(code || "unknown", text);
}

export class CloudRequest {
  readonly model: string;
  readonly cwd: string;
  readonly effort: string;
  readonly thinkingDisplay: "summarized" | "omitted";
  readonly messages: Message[];
  readonly tools: CloudTool[];
  readonly systemPrompt: string;

  constructor(ctx: RequestContext, messages: Message[], tools: unknown[]) {
    this.model = string(ctx.model, "requested model");
    if (this.model !== CLOUD_MODEL_ID)
      throw new Error(`Cloud supports only ${CLOUD_MODEL_ID}; no model fallback is permitted`);
    this.cwd = string(ctx.cwd, "local working directory");
    this.effort = ctx.effort ?? CLOUD_DEFAULT_EFFORT;
    this.thinkingDisplay =
      ctx.showThinkingSummaries !== false && !ctx.suppressThinkingSummary
        ? "summarized"
        : "omitted";
    this.tools = cloudTools(tools);
    this.messages = structuredClone(messages.filter((message) => message.role !== "system"));
    this.systemPrompt = messages
      .filter((message) => message.role === "system")
      .map((message) => {
        return message.content
          .map((block) => {
            if (block.type !== "text")
              throw new Error("Cloud system messages must contain text only");
            return block.text;
          })
          .join("\n");
      })
      .join("\n\n");
  }
}

export function translateRequestCloud(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): CloudRequest {
  return new CloudRequest(ctx, messages, tools);
}

export function cloudUserContent(blocks: ContentBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image", source: { ...block.source } };
    throw new Error(`Cloud user messages do not support ${block.type} blocks`);
  });
}

export async function* translateResponseCloud(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  let started = false;
  let refusal: string | undefined;
  let lastTextMessageId: string | undefined;
  const seenBlocks = new Set<string>();
  for await (const frame of parseSse(raw)) {
    if (!frame.data || (frame.event !== "client_event" && frame.event !== "ephemeral_event"))
      continue;
    const { payload } = parseCloudEvent(JSON.parse(frame.data));
    if (payload.type === "assistant") {
      const message = record(payload.message, "assistant message");
      const syntheticError = cloudSyntheticAssistantError(payload);
      if (syntheticError) {
        const refusal = cloudAssistantRefusal(message);
        if (!refusal) throw syntheticError;
        if (!started) yield { kind: "message_start" };
        yield { kind: "text_delta", text: refusal };
        yield { kind: "message_stop", stop_reason: "refusal", refusal };
        return;
      }
      if (!started) {
        started = true;
        yield {
          kind: "message_start",
          id: string(message.id, "assistant message.id"),
          ...(typeof message.model === "string" ? { model: message.model } : {}),
        };
      }
      if (!Array.isArray(message.content))
        throw new Error("Cloud assistant message is missing content");
      for (const value of message.content) {
        const block = record(value, "assistant content block");
        const key = JSON.stringify([message.id, block]);
        if (seenBlocks.has(key)) continue;
        seenBlocks.add(key);
        if (block.type === "text") {
          const id = string(message.id, "assistant message.id");
          const text = string(block.text, "assistant text");
          if (lastTextMessageId !== undefined && lastTextMessageId !== id)
            yield { kind: "text_delta", text: "\n\n" };
          lastTextMessageId = id;
          yield { kind: "text_delta", text };
        }
        if (block.type === "thinking") {
          if (typeof block.thinking === "string" && block.thinking.length > 0)
            yield { kind: "thinking_delta", text: block.thinking };
          if (typeof block.signature === "string")
            yield { kind: "thinking_signature", signature: block.signature };
        }
        // tool_use blocks describe intent. Only a validated SDK tools/call can dispatch locally.
      }
      refusal = cloudAssistantRefusal(message) ?? refusal;
      const usage = cloudUsageEvent(message.usage, payload.contextTokens);
      if (usage) yield usage;
      continue;
    }
    if (payload.type === "control_request") {
      const request = record(payload.request, "control request");
      if (request.subtype !== "mcp_message" || request.server_name !== MCP_SERVER_NAME) continue;
      const rpc = record(request.message, "MCP message");
      if (rpc.method !== "tools/call") continue;
      const params = record(rpc.params, "tools/call params");
      const meta = record(params._meta, "tools/call _meta");
      const id = string(meta["claudecode/toolUseId"], "claudecode/toolUseId");
      const name = string(params.name, "local tool name");
      const input = record(params.arguments, "local tool input");
      if (!started) yield { kind: "message_start" };
      const usage = cloudUsageEvent(payload.usage, payload.contextTokens);
      if (usage) yield usage;
      yield { kind: "tool_call_start", id, name };
      yield { kind: "tool_call_input_delta", id, partial: JSON.stringify(input) };
      yield { kind: "tool_call_complete", id, name, input };
      yield { kind: "message_stop", stop_reason: "tool_calls" };
      return;
    }
    if (payload.type === "error") {
      throw streamErrorToHttpError({
        provider: "anthropic-cloud",
        rawBody: JSON.stringify(payload),
      });
    }
    if (payload.type === "result") {
      const usage = cloudUsageEvent(payload.usage, payload.contextTokens);
      if (usage) yield usage;
      if (payload.is_error === true || payload.subtype !== "success") {
        const detail = resultError(payload);
        yield { kind: "error", error: detail };
        yield { kind: "message_stop", stop_reason: "error", ...(refusal ? { refusal } : {}) };
        return;
      }
      yield {
        kind: "message_stop",
        stop_reason: refusal ? "refusal" : "stop",
        ...(refusal ? { refusal } : {}),
      };
      return;
    }
  }
}

function cloudUsageEvent(value: unknown, contextTokens: unknown): ProviderEvent | null {
  const billing = usageFromAnthropic(value);
  if (
    contextTokens !== null &&
    (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens < 0)
  )
    return billing;
  if (billing?.kind === "usage") return { ...billing, contextTokens };
  return { kind: "usage", contextTokens };
}

export function cloudAssistantRefusal(message: Record<string, unknown>): string | undefined {
  const details = message.stop_details;
  if (
    details &&
    typeof details === "object" &&
    "explanation" in details &&
    typeof details.explanation === "string"
  ) {
    return details.explanation;
  }
  const texts: string[] = [];
  if (Array.isArray(message.content)) {
    for (const value of message.content) {
      const block = record(value, "assistant content block");
      if (block.type === "refusal")
        return typeof block.refusal === "string" ? block.refusal : "Cloud refused the request";
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  if (message.stop_reason !== "refusal") return;
  return texts.join("\n").trim() ? texts.join("\n") : "Cloud refused the request";
}

export function resultError(payload: Record<string, unknown>): string {
  const errors = Array.isArray(payload.errors)
    ? payload.errors.filter((value) => typeof value === "string")
    : [];
  const result = typeof payload.result === "string" ? payload.result : "";
  return (
    [...errors, result].filter(Boolean).join("\n") ||
    `Cloud result: ${String(payload.subtype ?? "error")}`
  );
}
