import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clear as clearBackgroundTasks,
  startShellTask,
} from "@/engine/background/tasks/background.ts";
import {
  registerWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { _resetGoalsForTesting, getActiveGoal, setActiveGoal } from "@/engine/queue/state.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

registerAllProviders();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeProvider(responses: readonly string[]): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    ...providers.get("xai"),
    id: "xai",
    stream: async function* () {
      const response = responses[calls];
      calls += 1;
      if (response === undefined) throw new Error(`unexpected provider call ${calls}`);
      yield encoder.encode(response);
    },
    translateResponse: async function* (raw) {
      let text = "";
      for await (const chunk of raw) text += decoder.decode(chunk);
      yield { kind: "message_start", id: `msg-${calls}` };
      yield { kind: "text_delta", text };
      yield { kind: "message_stop", stop_reason: "stop" };
    },
  };
  return { provider, calls: () => calls };
}

function makeHost(sessionId: string): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: {
        id: sessionId,
        cwd: process.cwd(),
        messages: [],
        records: [],
      } as never,
      broker: {
        read: () => ({
          provider: "xai",
          model: "grok-4.5",
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "xai", defaultModel: "grok-4.5" } as never,
    },
    compactState: {
      rapidRefillBreakerOpen: false,
      rapidRefillCount: 0,
      consecutiveCompactFailures: 0,
      turnsSinceLast: Number.POSITIVE_INFINITY,
      lastAutoCompactAttemptTurnId: null,
    },
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

function makeRunningWorkflow(id: string, sessionId: string): LocalWorkflowTaskState {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: process.cwd(),
    sessionId,
    workflowName: "test",
    description: "test workflow",
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController: new AbortController(),
  };
}

async function collectEvents(host: TurnLoopHost): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runTurn(host, "continue")) events.push(event);
  return events;
}

beforeEach(() => {
  _resetGoalsForTesting();
  resetWorkflowTasksForTests();
  clearBackgroundTasks();
  emitQueue._resetForTests();
  registerAllProviders();
});

afterEach(() => {
  _resetGoalsForTesting();
  resetWorkflowTasksForTests();
  clearBackgroundTasks();
  emitQueue._resetForTests();
  registerAllProviders();
});

describe("goal background workflow parking", () => {
  test("parks before goal classification while this session owns a running workflow", async () => {
    const sessionId = "session-1";
    const fake = makeProvider(["The workflow is still running."]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "workflow completes");
    registerWorkflowTask(makeRunningWorkflow("workflow-1", sessionId));

    const events = await collectEvents(makeHost(sessionId));

    expect(fake.calls()).toBe(1);
    expect(events).toContainEqual({
      kind: "goal_paused_bg",
      condition: "workflow completes",
      iteration: 0,
      runningBackgroundTasks: 1,
    });
    expect(events.some((event) => event.kind === "goal_eval_start")).toBe(false);
    expect(events.some((event) => event.kind === "goal_not_met")).toBe(false);
    expect(events.some((event) => event.kind === "goal_continue")).toBe(false);
    expect(getActiveGoal(sessionId)).toBeDefined();
  });

  test("parks before goal classification while this session owns a running background shell", async () => {
    const sessionId = "session-1";
    const fake = makeProvider(["The background shell is still running."]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "shell completes");
    startShellTask({
      shellId: "shell-1",
      command: "sleep 999",
      parentToolCallId: "tool-shell-1",
      sessionId,
    });

    const events = await collectEvents(makeHost(sessionId));

    expect(fake.calls()).toBe(1);
    expect(events).toContainEqual({
      kind: "goal_paused_bg",
      condition: "shell completes",
      iteration: 0,
      runningBackgroundTasks: 1,
    });
    expect(events.some((event) => event.kind === "goal_eval_start")).toBe(false);
    expect(events.some((event) => event.kind === "goal_not_met")).toBe(false);
    expect(events.some((event) => event.kind === "goal_continue")).toBe(false);
    expect(getActiveGoal(sessionId)).toBeDefined();
  });

  test("does not park for a background shell owned by another session", async () => {
    const sessionId = "session-1";
    const fake = makeProvider([
      "This session has no running background shell.",
      '{"ok":true,"reason":"the response confirms no work remains"}',
    ]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "no work remains");
    startShellTask({
      shellId: "shell-other",
      command: "sleep 999",
      parentToolCallId: "tool-shell-other",
      sessionId: "session-2",
    });

    const events = await collectEvents(makeHost(sessionId));

    expect(fake.calls()).toBe(2);
    expect(events.some((event) => event.kind === "goal_paused_bg")).toBe(false);
    expect(events).toContainEqual({
      kind: "goal_met",
      condition: "no work remains",
      iteration: 1,
    });
    expect(getActiveGoal(sessionId)).toBeUndefined();
  });

  test("does not park for a workflow owned by another session", async () => {
    const sessionId = "session-1";
    const fake = makeProvider([
      "This session has no running workflow.",
      '{"ok":true,"reason":"the response confirms no work remains"}',
    ]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "no work remains");
    registerWorkflowTask(makeRunningWorkflow("workflow-2", "session-2"));

    const events = await collectEvents(makeHost(sessionId));

    expect(fake.calls()).toBe(2);
    expect(events.some((event) => event.kind === "goal_paused_bg")).toBe(false);
    expect(events).toContainEqual({
      kind: "goal_met",
      condition: "no work remains",
      iteration: 1,
    });
    expect(getActiveGoal(sessionId)).toBeUndefined();
  });

  test("halts repeated unmet continuations at the stop-hook cap", async () => {
    const previousCap = process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
    process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = "1";
    try {
      const sessionId = "session-1";
      const fake = makeProvider([
        "Still working.",
        '{"ok":false,"reason":"work remains"}',
        "Still working.",
        '{"ok":false,"reason":"work remains"}',
      ]);
      providers.register(fake.provider);
      setActiveGoal(sessionId, "all work completes");

      const events = await collectEvents(makeHost(sessionId));

      expect(fake.calls()).toBe(4);
      expect(events.filter((event) => event.kind === "goal_continue")).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.kind === "error" &&
            event.error.includes("goal remained unmet for 2 continuations"),
        ),
      ).toBe(true);
      expect(getActiveGoal(sessionId)).toBeDefined();
    } finally {
      if (previousCap === undefined) delete process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
      else process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = previousCap;
    }
  });
});
