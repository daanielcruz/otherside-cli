import {
  accountFingerprint,
  sameAccountFingerprint,
} from "@/engine/providers/_shared/account-identity.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import {
  type ThinkingProvenance,
  thinkingProvenance,
} from "@/engine/providers/_shared/thinking-provenance.ts";
import {
  ensureNonEmptyErrorContent,
  sanitizeToolResultContent,
} from "@/engine/providers/_shared/tool-result.ts";
import { usageFromAnthropic } from "@/engine/providers/_shared/usage.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

interface KimiBlock {
  type: string;
  [k: string]: unknown;
}

interface KimiMessage {
  role: "user" | "assistant";
  content: KimiBlock[];
}

interface KimiReplayOpts {
  currentProvider: ProviderId | undefined;
  currentAccount: string;
  messageProvenance: ThinkingProvenance;
}

function blockToKimi(block: ContentBlock, replay: KimiReplayOpts): KimiBlock | null {
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
      };
    case "tool_result": {
      const toolResultContent = sanitizeToolResultContent(block.content);
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.is_error ? ensureNonEmptyErrorContent(toolResultContent) : toolResultContent,
        ...(block.is_error ? { is_error: true } : {}),
      };
    }
    case "thinking": {
      // Thinking only replays to the provider that produced it — a foreign
      // block never ships, signed or not. A signed block additionally requires
      // the credential that signed it; anything else is rejected server-side
      // as a modified signature. Same-provider unsigned thinking carries no
      // credential binding and replays as-is. Provenance is judged per block
      // (a rebuilt message can carry blocks from several producers), with the
      // message stamp as legacy fallback.
      const produced = thinkingProvenance(block, replay.messageProvenance);
      if (!replay.currentProvider || produced.producedBy !== replay.currentProvider) return null;
      if (
        block.signature &&
        !sameAccountFingerprint(produced.producedAccount, replay.currentAccount)
      ) {
        return null;
      }
      return {
        type: "thinking",
        thinking: block.text,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    }
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

export function buildKimiMessages(
  messages: Message[],
  currentProvider?: ProviderId,
): {
  system: KimiBlock[] | undefined;
  out: KimiMessage[];
} {
  // Derived fresh at request build so a credential switch (even mid-turn
  // from another client) gates signature replay on the very next request.
  const currentAccount = currentProvider ? accountFingerprint(currentProvider) : "";
  const systemBlocks: KimiBlock[] = [];
  const out: KimiMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      for (const b of msg.content) {
        if (b.type !== "text") continue;
        systemBlocks.push({
          type: "text",
          text: b.text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        });
      }
      continue;
    }
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const replay: KimiReplayOpts = {
      currentProvider,
      currentAccount,
      messageProvenance: msg,
    };
    const blocks: KimiBlock[] = [];
    for (const block of msg.content) {
      const k = blockToKimi(block, replay);
      if (k !== null) blocks.push(k);
    }
    if (blocks.length === 0) continue;
    out.push({ role, content: blocks });
  }
  return { system: systemBlocks.length > 0 ? systemBlocks : undefined, out };
}

export function userIdMetadata(sessionId: string): string {
  return JSON.stringify({
    device_id: "",
    account_uuid: "",
    session_id: sessionId,
  });
}

export function tagLastToolCache(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  if (!last || typeof last !== "object") return tools;
  const cloned = { ...(last as Record<string, unknown>) };
  cloned.cache_control = { type: "ephemeral", ttl: "5m" };
  return [...tools.slice(0, -1), cloned];
}

interface KimiToolBlockState {
  id: string;
  name: string;
  buffer: string;
}

export async function* translateResponseKimi(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const tools = new Map<number, KimiToolBlockState>();
  let stopReason = "stop";
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
            try {
              parsed = JSON.parse(tool.buffer);
            } catch {
              parsed = tool.buffer;
            }
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
          stopReason = mapKimiStopReason(delta.stop_reason);
        }
        const usage = usageFromAnthropic(data.usage);
        if (usage) yield usage;
        break;
      }
      case "message_stop": {
        yield { kind: "message_stop", stop_reason: stopReason };
        return;
      }
      case "error": {
        throw streamErrorToHttpError({
          provider: "kimi/coding/messages",
          rawBody: ev.data,
        });
      }
      default:
        break;
    }
  }
}

function mapKimiStopReason(r: string): string {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}
