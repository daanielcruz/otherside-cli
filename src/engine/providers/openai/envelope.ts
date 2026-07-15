import { readRawToolDecl } from "@/engine/providers/_shared/tool-decl.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { toolResultText } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionsBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  max_tokens?: number;
}

export interface SimpleChatBody {
  model: string;
  system_prompt: string;
  input: string;
}

export interface OpenAiTranslated {
  chat: ChatCompletionsBody;
  simple: SimpleChatBody;
  source: Message[];
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toolCallsFromBlocks(blocks: ContentBlock[]): ChatToolCall[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}),
      },
    }));
}

function messagesToChat(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: blocksToText(m.content) });
      continue;
    }
    if (m.role === "user") {
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        out.push({ role: "tool", content: toolResultText(r.content), tool_call_id: r.tool_use_id });
      }
      const parts: ChatContentPart[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text.length > 0) {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          });
        }
      }
      const hasImage = parts.some((p) => p.type === "image_url");
      if (parts.length > 0) {
        if (hasImage) {
          out.push({ role: "user", content: parts });
        } else {
          out.push({
            role: "user",
            content: parts
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          });
        }
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = blocksToText(m.content);
      const calls = toolCallsFromBlocks(m.content);
      const msg: ChatMessage = { role: "assistant", content: text };
      if (calls.length > 0) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    if (m.role === "tool") {
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      );
      for (const r of toolResults) {
        out.push({ role: "tool", content: toolResultText(r.content), tool_call_id: r.tool_use_id });
      }
    }
  }
  return out;
}

function toolsToChat(tools: unknown[]): unknown[] {
  return tools
    .map((t) => {
      const fields = readRawToolDecl(t);
      if (!fields) return null;
      const { name, description, parameters } = fields;
      return {
        type: "function",
        function: {
          name,
          ...(description !== undefined ? { description } : {}),
          parameters,
        },
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
}

function simpleChatPayload(req: ChatCompletionsBody, messages: Message[]): SimpleChatBody {
  const systemPrompt = messagesToChat(messages)
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .filter((s) => s.length > 0)
    .join("\n\n");
  const nonSystem = messages.filter((m) => m.role !== "system");
  let input: string;
  if (nonSystem.length === 1 && nonSystem[0]?.role === "user") {
    input = blocksToText(nonSystem[0].content);
  } else {
    input = nonSystem
      .map((m) => {
        const text = blocksToText(m.content).trim();
        const calls = toolCallsFromBlocks(m.content);
        if (text.length === 0 && calls.length === 0) return null;
        const label =
          m.role === "user"
            ? "User"
            : m.role === "assistant"
              ? "Assistant"
              : m.role === "tool"
                ? "Tool"
                : "System";
        if (calls.length === 0) return `${label}: ${text}`;
        const names = calls.map((c) => c.function.name).join(", ");
        if (text.length === 0) return `${label}: [tool calls: ${names}]`;
        return `${label}: ${text}\n[tool calls: ${names}]`;
      })
      .filter((s): s is string => s !== null)
      .join("\n\n");
  }
  return {
    model: req.model,
    system_prompt: systemPrompt,
    input,
  };
}

export function translateRequest(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const chatMessages = messagesToChat(messages);
  const chat: ChatCompletionsBody = {
    model: ctx.model,
    messages: chatMessages,
    stream: true,
  };
  const t = toolsToChat(tools);
  if (t.length > 0) {
    chat.tools = t;
    chat.tool_choice = "auto";
    chat.parallel_tool_calls = true;
  }
  const simple = simpleChatPayload(chat, messages);
  const out: OpenAiTranslated = { chat, simple, source: messages };
  return out;
}
