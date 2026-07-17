import { describe, expect, it } from "bun:test";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { buildAnthropicMessages, translateResponseAnthropic } from "../translate.ts";

async function* sse(chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function messageStop(events: ProviderEvent[]) {
  return events.find((e) => e.kind === "message_stop") as
    | Extract<ProviderEvent, { kind: "message_stop" }>
    | undefined;
}

describe("translateResponseAnthropic stop reasons", () => {
  it("surfaces a refusal stop_reason with its explanation", async () => {
    const explanation = "This request triggered cyber-related safeguards.";
    const events = await collect(
      translateResponseAnthropic(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":${JSON.stringify(explanation)}}}}\n\n`,
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    );
    const stop = messageStop(events);
    expect(stop?.stop_reason).toBe("refusal");
    expect(stop?.refusal).toBe(explanation);
  });

  it("maps end_turn to stop with no refusal field", async () => {
    const events = await collect(
      translateResponseAnthropic(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    );
    const stop = messageStop(events);
    expect(stop?.stop_reason).toBe("stop");
    expect(stop?.refusal).toBeUndefined();
  });

  it("finishes on message_stop without waiting for transport EOF", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      await new Promise<never>(() => {});
    }

    const stream = translateResponseAnthropic(source())[Symbol.asyncIterator]();
    expect((await stream.next()).value).toEqual({
      kind: "message_stop",
      stop_reason: "stop",
    });

    const completion = await Promise.race([
      stream.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    expect(completion).not.toBeNull();
    expect(completion?.done).toBe(true);
  });

  it("recovers a terminal tool input missing only its final closer", async () => {
    const events = await collect(
      translateResponseAnthropic(
        sse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3"}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"Bash"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"printf ok\\""}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    );

    expect(events.find((event) => event.kind === "tool_call_complete")).toEqual({
      kind: "tool_call_complete",
      id: "tool_1",
      name: "Bash",
      input: { command: "printf ok" },
    });
  });
});

describe("buildAnthropicMessages PDF blocks", () => {
  it("encodes a PDF tool result as a document block", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "pdf",
            content: [
              {
                type: "pdf",
                source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
                filename: "document.pdf",
                pageCount: 1,
                bytes: 3,
              },
            ],
          },
        ],
      },
    ];
    const ctx = { provider: "anthropic", model: "claude-opus-4-8" } as RequestContext;
    expect(buildAnthropicMessages(messages, ctx).out[0]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "pdf",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          },
        ],
      },
    ]);
  });
});
