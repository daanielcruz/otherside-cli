import { describe, expect, it } from "bun:test";
import { type DispatchEntry, settleDispatch } from "@/engine/queue/runtime/turn/tool-dispatch.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { ToolResult } from "@/kernel/std/types/message.ts";

describe("background dispatch placeholders", () => {
  it("lets the parent continue independent work", async () => {
    let resolveDispatch: ((result: ToolResult) => void) | undefined;
    const dispatchPromise = new Promise<ToolResult>((resolve) => {
      resolveDispatch = resolve;
    });
    const entry: DispatchEntry = {
      call: { id: "agent-call", name: "Agent", input: {} },
      queue: new AsyncStream<AgentEvent>(),
      abortController: new AbortController(),
      isAgentTool: true,
      isBackgroundable: true,
      bgTaskId: undefined,
      flags: { backgrounded: true, dispatchDone: false, settled: false },
      backgroundPromise: Promise.resolve(),
      dispatchPromise,
      outcome: Promise.resolve({ kind: "failed", error: null }),
    };
    const host: TurnLoopHost = {
      cancelled: false,
      currentTurnId: null,
      activeAbortController: null,
      activeToolAbortControllers: new Set<AbortController>(),
      injections: makeQueue(),
      deps: {
        session: { id: "test", cwd: process.cwd(), messages: [], records: [] } as never,
        broker: {} as never,
        config: {} as never,
      },
      compactState: {
        circuitOpen: false,
        rapidRefillBreakerOpen: false,
        rapidRefillCount: 0,
        turnsSinceLast: Number.POSITIVE_INFINITY,
        consecutiveFailures: 0,
      },
      sessionAllowedToolPatterns: new Set<string>(),
      loadedNestedMemoryPaths: new Set<string>(),
      nestedMemoryByPath: new Map<string, string>(),
      pendingUserInputDrainer: null,
      cancel: () => {},
      getNestedMemorySnapshot: () => [],
    };

    const outcome = await settleDispatch(host, entry);

    expect(outcome.kind).toBe("backgrounded");
    if (outcome.kind === "backgrounded") {
      expect(outcome.placeholder).toContain("Continue independent, non-overlapping work");
      expect(outcome.placeholder).not.toContain("Do not generate any other text");
    }

    resolveDispatch?.({ tool_use_id: "agent-call", content: "done" });
    await dispatchPromise;
  });

  it("clears the Bash handoff grace timer when dispatch wins", async () => {
    let resolveDispatch: ((result: ToolResult) => void) | undefined;
    const dispatchPromise = new Promise<ToolResult>((resolve) => {
      resolveDispatch = resolve;
    });
    const entry: DispatchEntry = {
      call: { id: "bash-call", name: "Bash", input: { command: "sleep 1" } },
      queue: new AsyncStream<AgentEvent>(),
      abortController: new AbortController(),
      isAgentTool: false,
      isBackgroundable: true,
      bgTaskId: undefined,
      flags: { backgrounded: true, dispatchDone: false, settled: false },
      backgroundPromise: Promise.resolve(),
      dispatchPromise,
      outcome: Promise.resolve({ kind: "failed", error: null }),
    };
    const host: TurnLoopHost = {
      cancelled: false,
      currentTurnId: null,
      activeAbortController: null,
      activeToolAbortControllers: new Set<AbortController>(),
      injections: makeQueue(),
      deps: {
        session: { id: "test", cwd: process.cwd(), messages: [], records: [] } as never,
        broker: {} as never,
        config: {} as never,
      },
      compactState: {
        circuitOpen: false,
        rapidRefillBreakerOpen: false,
        rapidRefillCount: 0,
        turnsSinceLast: Number.POSITIVE_INFINITY,
        consecutiveFailures: 0,
      },
      sessionAllowedToolPatterns: new Set<string>(),
      loadedNestedMemoryPaths: new Set<string>(),
      nestedMemoryByPath: new Map<string, string>(),
      pendingUserInputDrainer: null,
      cancel: () => {},
      getNestedMemorySnapshot: () => [],
    };

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const handle = {} as ReturnType<typeof setTimeout>;
    let resolveArmed: (() => void) | undefined;
    const armed = new Promise<void>((resolve) => {
      resolveArmed = resolve;
    });
    let cleared: ReturnType<typeof setTimeout> | undefined;
    globalThis.setTimeout = ((_callback: unknown, _ms?: number) => {
      resolveArmed?.();
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      cleared = timer;
    }) as typeof clearTimeout;

    try {
      const settling = settleDispatch(host, entry);
      await armed;
      resolveDispatch?.({
        tool_use_id: "bash-call",
        content: "running",
        meta: { kind: "bash", status: "background", shell_id: "shell-real" },
      });
      expect((await settling).kind).toBe("backgrounded");
      expect(cleared).toBe(handle);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
