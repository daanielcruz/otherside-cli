import { expect, it } from "bun:test";
import { consumeForkStream } from "@/engine/background/subagents/fork/stream-consumer.ts";
import type { ForkEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

async function* providerEvents(): AsyncIterable<ProviderEvent> {
  yield { kind: "tool_call_start", id: "design", name: "create_design" };
  yield { kind: "tool_call_input_delta", id: "design", partial: '{"content":"<main>' };
  yield { kind: "tool_call_start", id: "read", name: "Read" };
  yield { kind: "tool_call_input_delta", id: "read", partial: '{"file_path":"secret"}' };
  yield {
    kind: "tool_call_complete",
    id: "design",
    name: "create_design",
    input: { content: "<main>" },
  };
  yield {
    kind: "tool_call_complete",
    id: "read",
    name: "Read",
    input: { file_path: "secret" },
  };
  yield { kind: "message_stop", stop_reason: "tool_use" };
}

it("keeps the fork's latest context snapshot separate from its billed usage", async () => {
  const emitted: ForkEvent[] = [];
  async function* events(): AsyncIterable<ProviderEvent> {
    yield { kind: "usage", inputTokens: 190_000, outputTokens: 10_000, contextTokens: 50_000 };
    yield { kind: "usage", contextTokens: 40_000 };
    yield { kind: "usage", outputTokens: 10_000 };
    yield { kind: "usage", contextTokens: null };
    yield { kind: "usage", outputTokens: 10_000 };
    yield { kind: "usage", contextTokens: 0 };
    yield { kind: "message_stop", stop_reason: "stop" };
  }
  const outcome = await consumeForkStream({
    stream: events(),
    ctx: {
      provider: "anthropic-cloud",
      model: "claude-sonnet-5-5",
      effort: null,
      permissionMode: "default",
      sessionId: "session",
      cwd: "/workspace",
    },
    forkId: "child",
    parentRef: { parentToolCallId: "parent" },
    emit: (event) => emitted.push(event),
    finish: async (_event, result) => result,
    appendSidechainRecord: () => {},
  });
  expect(outcome.kind).toBe("ready");
  if (outcome.kind !== "ready") throw new Error("fork stream failed");
  expect(outcome.usage).toEqual({
    inputTokens: 190_000,
    outputTokens: 10_000,
    thoughtTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextTokens: 0,
  });
  const usageEvents = emitted.filter((event) => event.kind === "fork_usage");
  expect(usageEvents.map((event) => event.contextTokens)).toEqual([
    50_000,
    40_000,
    40_000,
    null,
    null,
    0,
  ]);
  for (const event of usageEvents) {
    expect(event.inputTokens + event.outputTokens).toBe(200_000);
    expect(event.forkId).toBe("child");
    expect(event.parentToolCallId).toBe("parent");
    expect(event.isSnapshot).toBe(true);
  }
});

it("emits streamed tool input only for explicitly allowed tool names", async () => {
  const emitted: ForkEvent[] = [];
  const controller = new AbortController();

  const outcome = await consumeForkStream({
    stream: providerEvents(),
    streamSignal: controller.signal,
    ctx: {} as RequestContext,
    forkId: "fork-1",
    parentRef: {},
    emit: (event) => emitted.push(event),
    streamToolInputFor: new Set(["create_design"]),
    finish: async (_event, result) => result,
    appendSidechainRecord: () => {},
  });

  expect(outcome.kind).toBe("ready");
  expect(emitted).toEqual([
    {
      kind: "fork_tool_input_delta",
      forkId: "fork-1",
      toolCallId: "design",
      toolName: "create_design",
      partial: '{"content":"<main>',
    },
  ]);
});

it("ignores serverHandled tool_call_complete events from being pushed to client toolCalls", async () => {
  async function* serverHandledEvents(): AsyncIterable<ProviderEvent> {
    yield {
      kind: "tool_call_complete",
      id: "ws-1",
      name: "WebSearch",
      input: { query: "grok docs", elapsed_ms: 100, durationSeconds: 0.1 },
      serverHandled: true,
    };
    yield {
      kind: "tool_call_complete",
      id: "read-1",
      name: "Read",
      input: { file_path: "foo.txt" },
    };
    yield { kind: "message_stop", stop_reason: "tool_use" };
  }

  const outcome = await consumeForkStream({
    stream: serverHandledEvents(),
    ctx: {} as RequestContext,
    forkId: "fork-2",
    parentRef: {},
    emit: () => {},
    finish: async (_event, result) => result,
    appendSidechainRecord: () => {},
  });

  expect(outcome.kind).toBe("ready");
  if (outcome.kind === "ready") {
    expect(outcome.toolCalls).toEqual([
      { id: "read-1", name: "Read", input: { file_path: "foo.txt" } },
    ]);
  }
});
