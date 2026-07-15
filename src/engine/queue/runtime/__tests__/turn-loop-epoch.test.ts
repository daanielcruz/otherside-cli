import { describe, expect, it } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

// A host whose pendingUserInputDrainer always reports a queued message, so every
// runTurn() invocation pauses at its first yield (queued_input_drained) — a real
// generator suspension point, reached before any provider/tool-dispatch code that
// would need heavier mocking.
function makeHost(messages: { role: "user"; content: ContentBlock[] }[]): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: { drain: () => [] } as never,
    deps: {
      session: { id: "s1", cwd: "/tmp", messages, records: [] } as never,
      broker: {
        read: () => ({
          provider: "codex",
          model: "gpt-5.5",
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "codex", defaultModel: "gpt-5.5" } as never,
    },
    compactState: {} as never,
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [{ text: "queued", blocks: [{ type: "text", text: "queued" }] }],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

describe("runTurn per-invocation epoch (D4 — zombie turn suppression)", () => {
  it("a lone turn's early exit still flips turn-active off (sanity baseline)", async () => {
    emitQueue._resetForTests();
    const host = makeHost([]);
    const it1 = runTurn(host, "")[Symbol.asyncIterator]();
    await it1.next();
    expect(emitQueue.getState().turnActive).toBe(true);
    await it1.return?.(undefined as never);
    expect(emitQueue.getState().turnActive).toBe(false);
  });

  it("a superseded (zombie) turn's finally does not clobber the turn that replaced it", async () => {
    emitQueue._resetForTests();
    const host = makeHost([]);

    // Turn 1 dispatches and parks at its first yield — standing in for a slow
    // tool whose own abort handling has not yet noticed cancellation.
    const zombie = runTurn(host, "")[Symbol.asyncIterator]();
    await zombie.next();
    expect(emitQueue.getState().turnActive).toBe(true);

    // User cancels; a fresh dispatch reuses the same host and resets the shared
    // `host.cancelled` flag for its own turn — bumping the epoch in the process.
    host.cancelled = true;
    const fresh = runTurn(host, "")[Symbol.asyncIterator]();
    await fresh.next();
    expect(host.cancelled).toBe(false); // reset for the fresh turn, as designed
    await fresh.return?.(undefined as never); // the fresh turn ends cleanly
    expect(emitQueue.getState().turnActive).toBe(false);

    // Something else (e.g. a third dispatch, or the fresh turn's own next
    // continuation) marks the system active again.
    emitQueue.setTurnActive(true);
    expect(emitQueue.getState().turnActive).toBe(true);

    // The zombie finally wakes and terminates. Without the epoch guard it would
    // call setTurnActive(false) unconditionally, stomping the state a newer turn
    // now owns.
    await zombie.return?.(undefined as never);
    expect(emitQueue.getState().turnActive).toBe(true);
  });
});
