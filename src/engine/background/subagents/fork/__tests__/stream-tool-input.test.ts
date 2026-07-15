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
    armStallTimer: () => {},
    isStalled: () => false,
    stallMs: 1_000,
    getLastStallLabel: () => "",
    getLastStallArmAt: () => 0,
    consecutiveStalls: 0,
    turn: 1,
    runStart: 0,
    appendSidechainRecord: () => {},
    resetStall: () => {},
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
