import { describe, expect, it } from "bun:test";
import { translateResponse } from "../translate.ts";

async function* sse(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("translateResponse stream termination", () => {
  it("finishes on [DONE] without waiting for transport EOF", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("data: [DONE]\n\n");
      await new Promise<never>(() => {});
    }

    const stream = translateResponse(source())[Symbol.asyncIterator]();
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
      translateResponse(
        sse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"printf ok\\""}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );

    expect(
      events.find((event) => (event as { kind?: string }).kind === "tool_call_complete"),
    ).toEqual({
      kind: "tool_call_complete",
      id: "call_1",
      name: "Bash",
      input: { command: "printf ok" },
    });
  });
});

describe("translateResponse error handling", () => {
  it("throws on event: error", async () => {
    const stream = translateResponse(
      sse([
        'event: error\ndata: {"error":{"message":"exceeded context window","code":"context_length_exceeded"}}\n\n',
      ]),
    );
    expect(collect(stream)).rejects.toThrow(/exceeded context window/);
  });

  it("throws on data containing error", async () => {
    const stream = translateResponse(
      sse(['data: {"error":{"message":"internal error","code":"internal_error"}}\n\n']),
    );
    expect(collect(stream)).rejects.toThrow(/internal error/);
  });
});
