import { describe, expect, it } from "bun:test";
import { routeIncomingMessage } from "@/ui/app/hooks/use-remote-sync.ts";

describe("routeIncomingMessage (D3a — gate remote incoming messages)", () => {
  it("queues instead of dispatching when a turn is live", () => {
    const queued: unknown[] = [];
    const dispatched: unknown[] = [];
    routeIncomingMessage(true, "hello", undefined, {
      queue: (text, blocks) => queued.push({ text, blocks }),
      dispatch: (text, opts) => dispatched.push({ text, opts }),
    });
    expect(queued).toEqual([{ text: "hello", blocks: undefined }]);
    expect(dispatched).toHaveLength(0);
  });

  it("dispatches directly when idle", () => {
    const queued: unknown[] = [];
    const dispatched: unknown[] = [];
    routeIncomingMessage(false, "hello", undefined, {
      queue: (text, blocks) => queued.push({ text, blocks }),
      dispatch: (text, opts) => dispatched.push({ text, opts }),
    });
    expect(queued).toHaveLength(0);
    expect(dispatched).toEqual([{ text: "hello", opts: { isRemote: true } }]);
  });

  it("carries blocks through on both paths", () => {
    const blocks = [{ type: "text" as const, text: "hi" }];
    let queuedBlocks: unknown;
    let dispatchedOpts: unknown;
    routeIncomingMessage(true, "hi", blocks, {
      queue: (_text, b) => {
        queuedBlocks = b;
      },
      dispatch: () => {},
    });
    routeIncomingMessage(false, "hi", blocks, {
      queue: () => {},
      dispatch: (_text, opts) => {
        dispatchedOpts = opts;
      },
    });
    expect(queuedBlocks).toBe(blocks);
    expect(dispatchedOpts).toEqual({ isRemote: true, blocks });
  });
});
