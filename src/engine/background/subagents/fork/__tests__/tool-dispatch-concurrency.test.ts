import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { list as listBackgroundTasks } from "../../../tasks/background.ts";
import { dispatchForkToolCalls } from "../tool-dispatch.ts";

// Controllable per-call promises so tests can decide settle order independently
// of dispatch order — that's what proves concurrency vs. sequencing.
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flushes both microtasks and one macrotask turn — enough for the awaits
// inside dispatchForkToolCalls's Phase C (maybePersistLargeToolResult, etc.)
// to progress between assertions.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type PipelineResult = { content: string; is_error?: boolean };
const deferredByCallId = new Map<string, Deferred<PipelineResult>>();

// The module registry keeps this mock for the rest of the run, so it spreads
// the real module (a partial surface fails later imports) and delegates back
// to the real dispatch once this file finishes — a leaked always-fake dispatch
// would swallow real tool executions in unrelated suites.
const realPipelineModule = await import("@/engine/tools/pipeline.ts");
// Captured by value: after mock.module the namespace's live binding IS the mock.
const realDispatch = realPipelineModule.dispatch;
let pipelineMockActive = true;
const mockDispatch = mock((call: ToolCall, ctx?: unknown, deps?: unknown) => {
  if (!pipelineMockActive) {
    return realDispatch(
      call,
      ctx as Parameters<typeof realDispatch>[1],
      deps as Parameters<typeof realDispatch>[2],
    );
  }
  const entry = deferredByCallId.get(call.id);
  if (!entry) throw new Error(`test bug: no deferred registered for call ${call.id}`);
  return entry.promise;
});

mock.module("@/engine/tools/pipeline.ts", () => ({
  ...realPipelineModule,
  dispatch: mockDispatch,
}));

afterAll(() => {
  pipelineMockActive = false;
});

function makeArgs(toolCalls: ToolCall[]) {
  const childTaskIdMap = new Map<string, string>();
  const ctx = {
    cwd: "/tmp",
    sessionId: "session-concurrency",
    bgTaskId: "parent-task-concurrency",
    childTaskIdMap,
  } as unknown as RequestContext;
  const emit = mock((_event: unknown) => {});
  const finish = mock(() => Promise.resolve({ output: "done", isError: false }));
  const appendSidechainRecord = mock((_record: unknown) => {});
  return {
    childTaskIdMap,
    emit,
    finish,
    appendSidechainRecord,
    args: {
      toolCalls,
      ctx,
      spec: {
        ctx,
        name: "test-fork",
        body: "",
        allowSet: new Set(["Agent", "Bash"]),
        prompt: "do something",
        parentToolCallId: "parent-tool-call",
      },
      forkId: "fork-concurrency",
      name: "test-fork",
      allowSet: new Set(["Agent", "Bash"]),
      parentRef: { parentToolCallId: "parent-tool-call" },
      compiledSchema: null,
      hookHandlers: [],
      state: {
        degenerateToolCalls: 0,
        lastFailingSignature: null,
        structuredOutputRetries: 0,
        lastStructuredError: null,
        structuredValue: null,
        structuredOutputConsumed: false,
      },
      emit,
      finish,
      appendSidechainRecord,
    },
  };
}

function agentCall(id: string): ToolCall {
  return {
    id,
    name: "Agent",
    input: { subagent_type: "samurai", prompt: `prompt for ${id}`, description: `desc ${id}` },
  };
}

function bashCall(id: string): ToolCall {
  return { id, name: "Bash", input: { command: `echo ${id}` } };
}

describe("dispatchForkToolCalls concurrency", () => {
  beforeEach(() => {
    // Agent is isConcurrencySafe in the real registry (src/engine/tools/builtins/agent.ts);
    // this suite doesn't import the full builtins bootstrap, so register a stand-in
    // that matches that one flag the fix depends on.
    toolRegistry.register({
      schema: {
        name: "Agent",
        description: "test",
        inputSchema: { type: "object", properties: {} },
      },
      isConcurrencySafe: true,
      run: async (call) => ({ tool_use_id: call.id, content: "unused" }),
    });
  });

  afterEach(() => {
    toolRegistry.unregister("Agent");
    deferredByCallId.clear();
    mockDispatch.mockClear();
  });

  it("starts both Agent dispatches (and emits both start events) before either settles", async () => {
    const dA = createDeferred<PipelineResult>();
    const dB = createDeferred<PipelineResult>();
    deferredByCallId.set("call-a", dA);
    deferredByCallId.set("call-b", dB);

    const { args, emit } = makeArgs([agentCall("call-a"), agentCall("call-b")]);
    const outcomePromise = dispatchForkToolCalls(args);

    // Phase A runs synchronously up to the first await (Promise.allSettled),
    // so by this point both dispatches must already have been started.
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const startEvents = emit.mock.calls
      .map((c) => c[0] as { kind: string; toolCallId: string })
      .filter((e) => e.kind === "fork_tool_dispatch_start");
    expect(startEvents.map((e) => e.toolCallId)).toEqual(["call-a", "call-b"]);

    dA.resolve({ content: "a done", is_error: false });
    dB.resolve({ content: "b done", is_error: false });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("ready");
  });

  it("preserves call order in results even when the second dispatch settles first", async () => {
    const dA = createDeferred<PipelineResult>();
    const dB = createDeferred<PipelineResult>();
    deferredByCallId.set("call-a", dA);
    deferredByCallId.set("call-b", dB);

    const { args } = makeArgs([agentCall("call-a"), agentCall("call-b")]);
    const outcomePromise = dispatchForkToolCalls(args);

    // b settles first; a settles after
    dB.resolve({ content: "b done", is_error: false });
    await tick();
    dA.resolve({ content: "a done", is_error: false });

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("unreachable");
    const ids = outcome.results.map((r) => (r as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(["call-a", "call-b"]);
    const contents = outcome.results.map((r) => (r as { content: string }).content);
    expect(contents).toEqual(["a done", "b done"]);
  });

  it("keeps non-concurrency-safe calls (Bash) sequential: second dispatch not started until the first settles", async () => {
    const dX = createDeferred<PipelineResult>();
    const dY = createDeferred<PipelineResult>();
    deferredByCallId.set("call-x", dX);
    deferredByCallId.set("call-y", dY);

    const { args } = makeArgs([bashCall("call-x"), bashCall("call-y")]);
    const outcomePromise = dispatchForkToolCalls(args);

    // Bash is not concurrency-safe by default (unregistered here), so
    // partitionForConcurrency puts each call in its own group.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]?.[0]).toMatchObject({ id: "call-x" });

    await tick();
    await tick();
    // still only one dispatch in flight — call-y's group hasn't started yet
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    dX.resolve({ content: "x done", is_error: false });
    await tick();
    await tick();
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    dY.resolve({ content: "y done", is_error: false });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("unreachable");
    const ids = outcome.results.map((r) => (r as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(["call-x", "call-y"]);
  });

  it("propagates a rejection from one concurrent dispatch only after the fulfilled sibling's bookkeeping completes", async () => {
    const dOk = createDeferred<PipelineResult>();
    const dErr = createDeferred<PipelineResult>();
    deferredByCallId.set("call-ok", dOk);
    deferredByCallId.set("call-err", dErr);

    const { args, emit, childTaskIdMap } = makeArgs([agentCall("call-ok"), agentCall("call-err")]);
    const outcomePromise = dispatchForkToolCalls(args);
    // Attach a handler immediately so Node/Bun never sees this as unhandled,
    // regardless of when the assertions below actually consume it.
    outcomePromise.catch(() => {});

    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // Reject the second call's dispatch while the first is still pending.
    dErr.reject(new Error("boom"));

    // With Promise.allSettled (not Promise.all) the overall dispatch must
    // still be pending here — this is the guard against reintroducing the
    // "sibling bookkeeping lost on first rejection" bug.
    const raceResult = await Promise.race([
      outcomePromise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      tick().then(() => "still-pending" as const),
    ]);
    expect(raceResult).toBe("still-pending");

    dOk.resolve({ content: "great success", is_error: false });
    await expect(outcomePromise).rejects.toThrow("boom");

    // The fulfilled sibling's result processing must have completed before
    // the throw — its complete event was emitted and its nested task closed.
    const completeEvents = emit.mock.calls.map(
      (c) => c[0] as { kind: string; toolCallId?: string; isError?: boolean },
    );
    expect(
      completeEvents.some(
        (e) =>
          e.kind === "fork_tool_dispatch_complete" &&
          e.toolCallId === "call-ok" &&
          e.isError === false,
      ),
    ).toBe(true);

    const tasks = listBackgroundTasks();
    const okTaskId = childTaskIdMap.get("call-ok");
    const errTaskId = childTaskIdMap.get("call-err");
    expect(okTaskId).toBeDefined();
    expect(errTaskId).toBeDefined();
    const okTask = tasks.find((t) => t.id === okTaskId);
    const errTask = tasks.find((t) => t.id === errTaskId);
    expect(okTask?.status).toBe("completed");
    expect(okTask?.result?.content).toBe("great success");
    expect(errTask?.status).toBe("error");
  });
});
