import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { AbortError } from "@/kernel/std/stream/abort.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  clear as clearBackgroundTasks,
  list as listBackgroundTasks,
  resetEmitThrottleForTests,
} from "../../../tasks/background.ts";
import * as bgControllers from "../../../tasks/background-controllers.ts";
import { dispatchForkToolCalls } from "../tool-dispatch.ts";

// The module registry keeps this mock for the rest of the run, so it spreads
// the real module (a partial surface fails later imports) and delegates back
// to the real dispatch once this file finishes — a leaked always-fake dispatch
// would swallow real tool executions in unrelated suites.
const realPipelineModule = await import("@/engine/tools/pipeline.ts");
// Captured by value: after mock.module the namespace's live binding IS the mock.
const realDispatch = realPipelineModule.dispatch;
let pipelineMockActive = true;
type DispatchResult = Awaited<ReturnType<typeof realDispatch>>;
const mockDispatch = mock(
  (
    call: ToolCall,
    ctx: RequestContext,
    deps: Parameters<typeof realDispatch>[2],
  ): Promise<DispatchResult | { content: string; is_error: boolean }> => {
    if (!pipelineMockActive) return realDispatch(call, ctx, deps);
    return Promise.resolve({
      content: "nested agent completed successfully",
      is_error: false,
    });
  },
);

mock.module("@/engine/tools/pipeline.ts", () => ({
  ...realPipelineModule,
  dispatch: mockDispatch,
}));

afterAll(() => {
  pipelineMockActive = false;
});

beforeEach(() => {
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  bgControllers._resetForTests();
  emitQueue._resetForTests();
});

afterEach(() => {
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  bgControllers._resetForTests();
  emitQueue._resetForTests();
});

describe("nested registration of Agent calls in fork tool dispatch", () => {
  it("returns immediately while a backgrounded child remains owned by its fork", async () => {
    const releaseOwner = emitQueue.registerOwner("fork-async");
    let completeChild: ((result: { content: string; is_error: boolean }) => void) | undefined;
    mockDispatch.mockImplementationOnce((_call, ctx) => {
      ctx?.backgroundController?.signal();
      return new Promise<{ content: string; is_error: boolean }>((resolve) => {
        completeChild = resolve;
      });
    });
    const childTaskIdMap = new Map<string, string>();
    const ctx = {
      cwd: "/tmp",
      sessionId: "session-async",
      bgTaskId: "parent-task-async",
      childTaskIdMap,
    } as unknown as RequestContext;
    const toolCall: ToolCall = {
      id: "call-async-agent",
      name: "Agent",
      input: { subagent_type: "samurai", prompt: "nested background test" },
    };

    const outcome = await dispatchForkToolCalls({
      toolCalls: [toolCall],
      ctx,
      spec: {
        ctx,
        name: "test-fork",
        body: "",
        allowSet: new Set(["Agent"]),
        prompt: "do",
      },
      forkId: "fork-async",
      name: "test-fork",
      allowSet: new Set(["Agent"]),
      parentRef: {},
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
      emit: mock(() => {}),
      finish: mock(() => Promise.resolve({ output: "done", isError: false })),
      appendSidechainRecord: mock(() => {}),
    });

    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") outcome.commitTaskCompletions();
    const childTaskId = childTaskIdMap.get(toolCall.id);
    const running = listBackgroundTasks().find((task) => task.id === childTaskId);
    expect(running?.status).toBe("running");
    expect(completeChild).toBeDefined();

    completeChild?.({
      content: "nested agent completed successfully",
      is_error: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    const completed = listBackgroundTasks().find((task) => task.id === childTaskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.result?.content).toBe("nested agent completed successfully");

    // A detached child delivers exactly one completion: the owner notification.
    const owned = emitQueue
      .peek({ ownerId: "fork-async" })
      .filter((item) => item.payload.kind === "task_notification_xml");
    expect(owned.length).toBe(1);
    expect(owned[0]?.target).toBe("inventory");
    releaseOwner();
  });

  it("propagates parent abort as AbortError and cancels the linked child", async () => {
    const parentAbort = new AbortController();
    mockDispatch.mockImplementationOnce(
      (_call, ctx) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(new AbortError());
          if (ctx?.abortSignal?.aborted) fail();
          else ctx?.abortSignal?.addEventListener("abort", fail, { once: true });
        }),
    );
    const childTaskIdMap = new Map<string, string>();
    const ctx = {
      cwd: "/tmp",
      sessionId: "session-cancel",
      bgTaskId: "parent-task-cancel",
      childTaskIdMap,
      abortSignal: parentAbort.signal,
    } as unknown as RequestContext;
    const toolCall: ToolCall = {
      id: "call-cancel-agent",
      name: "Agent",
      input: { subagent_type: "samurai", prompt: "wait" },
    };
    const pending = dispatchForkToolCalls({
      toolCalls: [toolCall],
      ctx,
      spec: { ctx, name: "parent", body: "", allowSet: new Set(["Agent"]), prompt: "do" },
      forkId: "fork-cancel",
      name: "parent",
      allowSet: new Set(["Agent"]),
      parentRef: {},
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
      emit: mock(() => {}),
      finish: mock(() => Promise.resolve({ output: "done", isError: false })),
      appendSidechainRecord: mock(() => {}),
    });
    const childTaskId = childTaskIdMap.get(toolCall.id);
    expect(childTaskId).toBeDefined();

    parentAbort.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(listBackgroundTasks().find((task) => task.id === childTaskId)?.status).toBe("killed");
    expect(emitQueue.peek().some((item) => item.replayKey?.startsWith(`bg:${childTaskId}:`))).toBe(
      false,
    );
  });

  it("does not queue an owner notification for a child that completed inline", async () => {
    const childTaskIdMap = new Map<string, string>();
    const ctx = {
      cwd: "/tmp",
      sessionId: "session-sync-inline",
      bgTaskId: "parent-task-sync",
      childTaskIdMap,
    } as unknown as RequestContext;
    const toolCall: ToolCall = {
      id: "call-sync-agent",
      name: "Agent",
      input: { subagent_type: "samurai", prompt: "nested inline test" },
    };

    const outcome = await dispatchForkToolCalls({
      toolCalls: [toolCall],
      ctx,
      spec: {
        ctx,
        name: "test-fork",
        body: "",
        allowSet: new Set(["Agent"]),
        prompt: "do",
      },
      forkId: "fork-sync-inline",
      name: "test-fork",
      allowSet: new Set(["Agent"]),
      parentRef: {},
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
      emit: mock(() => {}),
      finish: mock(() => Promise.resolve({ output: "done", isError: false })),
      appendSidechainRecord: mock(() => {}),
    });

    expect(outcome.kind).toBe("ready");
    const childTaskId = childTaskIdMap.get(toolCall.id);
    expect(listBackgroundTasks().find((task) => task.id === childTaskId)?.status).toBe("running");
    if (outcome.kind === "ready") outcome.commitTaskCompletions();
    const completed = listBackgroundTasks().find((task) => task.id === childTaskId);
    expect(completed?.status).toBe("completed");
    expect(completed?.terminalNotification).toBe("parent");

    // The result already went back inline as the tool_result; queuing an owner
    // notification too would deliver the same completion twice.
    const owned = emitQueue
      .peek({ ownerId: "fork-sync-inline" })
      .filter((item) => item.payload.kind === "task_notification_xml");
    expect(owned.length).toBe(0);
  });

  it("creates a child task with parentTaskId and completes it", async () => {
    const parentTaskId = "parent-task-123";
    const childTaskIdMap = new Map<string, string>();
    const ctx = {
      cwd: "/tmp",
      sessionId: "session-123",
      bgTaskId: parentTaskId,
      childTaskIdMap,
    } as unknown as RequestContext;

    const toolCall: ToolCall = {
      id: "call-inner-agent",
      name: "Agent",
      input: {
        subagent_type: "samurai",
        prompt: "nested task test",
        description: "Verify nested registration",
      },
    };

    const emit = mock(() => {});
    const finish = mock(() => Promise.resolve({ output: "done", isError: false }));
    const appendSidechainRecord = mock(() => {});

    const outcome = await dispatchForkToolCalls({
      toolCalls: [toolCall],
      ctx,
      spec: {
        ctx,
        name: "test-fork",
        body: "",
        allowSet: new Set(["Agent"]),
        prompt: "do something",
        parentToolCallId: "parent-tool-call",
      },
      forkId: "fork-123",
      name: "test-fork",
      allowSet: new Set(["Agent"]),
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
    });

    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") outcome.commitTaskCompletions();

    // The inner agent tool call should have registered a child task mapped in childTaskIdMap
    const childTaskId = childTaskIdMap.get("call-inner-agent");
    expect(childTaskId).toBeDefined();

    // Verify it is in the background tasks store
    const tasks = listBackgroundTasks();
    const childTask = tasks.find((t) => t.id === childTaskId);
    expect(childTask).toBeDefined();
    expect(childTask?.parentTaskId).toBe(parentTaskId);
    expect(childTask?.agentName).toBe("samurai");
    // inline nested spawns must be panel-visible (rawAgents filters on isBackgrounded)
    expect(childTask?.isBackgrounded).toBe(true);
    expect(childTask?.status).toBe("completed"); // Completed because mockDispatch succeeded
    expect(childTask?.result?.content).toBe("nested agent completed successfully");
  });
});
