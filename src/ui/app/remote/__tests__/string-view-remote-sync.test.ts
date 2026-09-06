import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { routeIncomingMessage } from "@/ui/app/remote/string-view-remote-sync.ts";

function collect() {
  const calls: { queued: [string, ContentBlock[] | undefined][]; dispatched: unknown[][] } = {
    queued: [],
    dispatched: [],
  };
  return {
    calls,
    handlers: {
      queue: (text: string, blocks?: ContentBlock[]) => calls.queued.push([text, blocks]),
      dispatch: (text: string, opts: { blocks?: ContentBlock[]; isRemote?: boolean }) =>
        calls.dispatched.push([text, opts]),
    },
  };
}

describe("routeIncomingMessage", () => {
  test("a live turn queues instead of racing the dispatch", () => {
    const { calls, handlers } = collect();
    routeIncomingMessage(true, "from phone", undefined, handlers);
    expect(calls.queued).toEqual([["from phone", undefined]]);
    expect(calls.dispatched).toHaveLength(0);
  });

  test("an idle session dispatches immediately as remote input", () => {
    const { calls, handlers } = collect();
    routeIncomingMessage(false, "from phone", undefined, handlers);
    expect(calls.queued).toHaveLength(0);
    expect(calls.dispatched).toEqual([["from phone", { isRemote: true }]]);
  });

  test("blocks travel with the dispatched message", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "hi" }];
    const { calls, handlers } = collect();
    routeIncomingMessage(false, "hi", blocks, handlers);
    expect(calls.dispatched).toEqual([["hi", { isRemote: true, blocks }]]);
  });
});
