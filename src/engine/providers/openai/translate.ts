import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { parseJsonWithPartialRecovery } from "@/engine/providers/_shared/streaming-json-repair.ts";
import { usageFromOpenAi } from "@/engine/providers/_shared/usage.ts";
import { translateRequest } from "@/engine/providers/openai/envelope.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";

export type { OpenAiTranslated } from "@/engine/providers/openai/envelope.ts";
export { translateRequest };

interface ChatChunk {
  id?: string;
  error?: unknown;
  usage?: unknown;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface ToolBuf {
  id: string;
  name: string;
  buffer: string;
}

export async function* translateResponse(
  raw: AsyncIterable<Uint8Array>,
): AsyncIterable<ProviderEvent> {
  const tools = new Map<number, ToolBuf>();
  const harmony = new HarmonyDecoder();
  let started = false;
  let stopReason = "stop";
  let sawTool = false;

  for await (const ev of parseSse(raw)) {
    const d = ev.data.trim();
    if (!d) continue;
    if (d === "[DONE]") break;
    if (ev.event === "error") {
      throw streamErrorToHttpError({ provider: "openai", rawBody: d });
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(d) as ChatChunk;
    } catch {
      continue;
    }
    if (chunk.error) {
      throw streamErrorToHttpError({ provider: "openai", rawBody: d });
    }
    if (!started) {
      started = true;
      yield { kind: "message_start" };
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        for (const out of harmony.feed(delta.content)) yield out;
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield { kind: "thinking_delta", text: reasoning };
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        let buf = tools.get(idx);
        if (!buf) {
          const id = tc.id ?? `${tc.function?.name ?? "tool"}_${Date.now()}_${idx}`;
          const name = tc.function?.name ?? "";
          buf = { id, name, buffer: "" };
          tools.set(idx, buf);
          sawTool = true;
          yield { kind: "tool_call_start", id, name };
        }
        if (tc.id && tc.id !== buf.id) buf.id = tc.id;
        if (tc.function?.name && !buf.name) buf.name = tc.function.name;
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          buf.buffer += args;
          yield { kind: "tool_call_input_delta", id: buf.id, partial: args };
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
      }
    }
    const usage = usageFromOpenAi(chunk.usage);
    if (usage) yield usage;
  }

  for (const [, buf] of tools) {
    let parsed: unknown = {};
    if (buf.buffer.trim().length > 0) {
      const result = parseJsonWithPartialRecovery(buf.buffer);
      parsed = result.ok ? result.value : buf.buffer;
    }
    yield { kind: "tool_call_complete", id: buf.id, name: buf.name, input: parsed };
  }

  for (const out of harmony.flush()) yield out;

  if (sawTool && stopReason === "stop") stopReason = "tool_calls";
  yield { kind: "message_stop", stop_reason: stopReason };
}

type HarmonyEvent = { kind: "text_delta"; text: string } | { kind: "thinking_delta"; text: string };

class HarmonyDecoder {
  private buffer = "";
  private channel: "analysis" | "thought" | "final" | "commentary" | null = null;
  private inMessage = false;
  private active = false;
  private expectingChannelName = false;

  feed(chunk: string): HarmonyEvent[] {
    this.buffer += chunk;
    if (!this.active) {
      if (this.buffer.includes("<|") && /<\|[a-z_]/i.test(this.buffer)) {
        this.active = true;
      } else {
        const out: HarmonyEvent[] = [{ kind: "text_delta", text: this.buffer }];
        this.buffer = "";
        return out;
      }
    }
    return this.consume();
  }

  flush(): HarmonyEvent[] {
    if (this.buffer.length === 0) return [];
    const out = this.consume();
    if (this.buffer.length > 0) {
      const text = this.buffer;
      this.buffer = "";
      if (this.expectingChannelName && isKnownChannelName(text)) {
        this.consumeChannelName(text);
        this.expectingChannelName = false;
      } else {
        this.expectingChannelName = false;
        out.push(this.routeText(text));
      }
    }
    return out.filter((e) => e.text.length > 0);
  }

  private consume(): HarmonyEvent[] {
    const out: HarmonyEvent[] = [];
    while (this.buffer.length > 0) {
      const tokenStart = this.buffer.indexOf("<|");
      if (tokenStart === -1) {
        if (this.expectingChannelName && isKnownChannelName(this.buffer)) {
          this.consumeChannelName(this.buffer);
          this.expectingChannelName = false;
          this.buffer = "";
          break;
        }
        this.expectingChannelName = false;
        out.push(this.routeText(this.buffer));
        this.buffer = "";
        break;
      }
      if (tokenStart > 0) {
        const segment = this.buffer.slice(0, tokenStart);
        this.buffer = this.buffer.slice(tokenStart);
        if (this.expectingChannelName && isKnownChannelName(segment)) {
          this.consumeChannelName(segment);
          this.expectingChannelName = false;
        } else {
          this.expectingChannelName = false;
          out.push(this.routeText(segment));
        }
      }
      const tokenEnd = this.buffer.indexOf("|>", 2);
      if (tokenEnd === -1) {
        if (this.buffer.length > 64) {
          out.push(this.routeText(this.buffer.slice(0, 1)));
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      }
      const token = this.buffer.slice(2, tokenEnd);
      this.buffer = this.buffer.slice(tokenEnd + 2);
      this.applyToken(token);
    }
    return out.filter((e) => e.text.length > 0);
  }

  private applyToken(token: string): void {
    const lc = token.toLowerCase();
    if (lc === "start" || lc.startsWith("start ")) {
      this.channel = null;
      this.inMessage = false;
      return;
    }
    if (lc === "channel" || lc.startsWith("channel ") || lc === "channel|") {
      this.inMessage = false;
      this.channel = null;
      this.expectingChannelName = true;
      return;
    }
    if (lc === "message") {
      this.inMessage = true;
      this.expectingChannelName = false;
      return;
    }
    if (lc === "end" || lc === "return") {
      this.inMessage = false;
      this.channel = null;
      this.expectingChannelName = false;
      return;
    }
    if (lc === "constrain" || lc === "constrained" || lc.startsWith("call") || lc === "arguments") {
      this.inMessage = false;
      this.expectingChannelName = false;
      return;
    }
    if (!this.inMessage) {
      const trimmed = lc.trim();
      if (trimmed === "analysis" || trimmed === "thought") {
        this.channel = trimmed as "analysis" | "thought";
      } else if (trimmed === "final") {
        this.channel = "final";
      } else if (trimmed === "commentary") {
        this.channel = "commentary";
      }
    }
  }

  private consumeChannelName(segment: string): void {
    const trimmed = segment.trim().toLowerCase();
    if (trimmed === "analysis" || trimmed === "thought") {
      this.channel = trimmed as "analysis" | "thought";
    } else if (trimmed === "final") {
      this.channel = "final";
    } else if (trimmed === "commentary") {
      this.channel = "commentary";
    }
  }

  private routeText(text: string): HarmonyEvent {
    if (this.channel === "analysis" || this.channel === "thought") {
      return { kind: "thinking_delta", text };
    }
    return { kind: "text_delta", text };
  }
}

function isKnownChannelName(segment: string): boolean {
  const trimmed = segment.trim().toLowerCase();
  return (
    trimmed === "analysis" ||
    trimmed === "thought" ||
    trimmed === "final" ||
    trimmed === "commentary"
  );
}

function mapFinishReason(r: string): string {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return r;
  }
}
