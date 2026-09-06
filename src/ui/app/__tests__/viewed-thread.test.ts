import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The task store persists under the config root, so this suite runs against a
// disposable one rather than writing rows into the real list.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "otherside-viewed-thread-"));
const PREVIOUS_CONFIG_DIR = process.env.OTHERSIDE_CONFIG_DIR;
process.env.OTHERSIDE_CONFIG_DIR = CONFIG_DIR;

const {
  clear: clearBackgroundTasks,
  setForkId,
  setRoute,
  setTaskParked,
  setUsageSnapshot,
  startTask,
  completeTask,
} = await import("@/engine/background/tasks/background.ts");
const {
  clear: clearTasks,
  create: createTask,
  clearScope: clearTaskScope,
} = await import("@/engine/background/tasks/index.ts");
const { queueAgentSteer, drainAgentSteers, clearAgentSteers } = await import(
  "@/engine/background/subagents/fork/steering.ts"
);
const { appStore, dispatch } = await import("@/store/app-store/index.ts");
const { queueActions } = await import("@/store/queue-store/index.ts");
const { viewedThread } = await import("@/ui/app/viewed-thread.ts");

const AGENT_FORK = "fork-viewed";
const initialAppState = appStore.getState();

beforeEach(() => {
  appStore.setState(() => initialAppState);
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: {
      provider: "anthropic",
      model: "claude-opus-5",
      effort: "high",
      fastMode: false,
      permissionMode: "yolo",
      orchestrationMode: "disabled",
    },
  });
});

afterEach(() => {
  dispatch({ type: "view/setViewingAgent", id: null });
  appStore.setState(() => initialAppState);
  clearBackgroundTasks();
  clearTasks();
  clearTaskScope(AGENT_FORK);
  clearAgentSteers(AGENT_FORK);
  queueActions.clear();
});

afterAll(() => {
  if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

/** A running agent with its own route, its own spend, and its own fork. */
function openAgent(): string {
  const task = startTask({
    parentToolCallId: "call-1",
    agentName: "reviewer",
    agentId: "general-purpose",
    isBackgrounded: true,
  });
  setForkId(task.id, AGENT_FORK);
  setRoute(task.id, { provider: "codex", model: "gpt-5.6-sol" }, "low");
  setUsageSnapshot(task.id, { inputTokens: 400, outputTokens: 90 });
  dispatch({ type: "view/setViewingAgent", id: task.id });
  return task.id;
}

describe("the thread the chrome is describing", () => {
  it("answers for the leader while no agent document is open", () => {
    queueActions.push({ id: "q1", text: "later", expanded: "later" });
    const thread = viewedThread();

    expect(thread.agent).toBeNull();
    expect(thread.broker.model).toBe("claude-opus-5");
    expect(thread.context).toBe(appStore.getState().usage.mainLastContext);
    expect(thread.queued).toHaveLength(1);
  });

  it("states the open agent's route and effort, keeping the session's own modes", () => {
    openAgent();
    const thread = viewedThread();

    expect(thread.broker.provider).toBe("codex");
    expect(thread.broker.model).toBe("gpt-5.6-sol");
    expect(thread.broker.effort).toBe("low");
    // Permission and orchestration govern the session, not the thread inside it.
    expect(thread.broker.permissionMode).toBe("yolo");
    expect(thread.broker.orchestrationMode).toBe("disabled");
  });

  it("reports the open agent's own spend, with none of the leader's cache", () => {
    dispatch({
      type: "usage/setMainLastContext",
      value: {
        inputTokens: 100_000,
        outputTokens: 5_000,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
      },
    });
    openAgent();
    const thread = viewedThread();

    expect(thread.context.inputTokens).toBe(400);
    expect(thread.context.outputTokens).toBe(90);
    expect(thread.context.cacheCreationInputTokens).toBe(0);
    expect(thread.context.cacheReadInputTokens).toBe(0);
  });

  it("follows the open agent's own run state and start time", () => {
    const id = openAgent();
    const running = viewedThread();
    expect(running.busy).toBe(true);
    expect(running.startedAt).toBe(running.agent?.startedAt ?? null);
    expect(running.verb).toBe("Running");

    completeTask(id, { content: "done", isError: false });
    const finished = viewedThread();
    expect(finished.busy).toBe(false);
    expect(finished.startedAt).toBeNull();
  });

  it("treats a parked agent as not busy until it wakes", () => {
    const id = openAgent();
    setTaskParked(id, true);
    const parked = viewedThread();
    expect(parked.busy).toBe(false);
    expect(parked.startedAt).toBeNull();

    setTaskParked(id, false);
    expect(viewedThread().busy).toBe(true);
  });

  it("keeps the leader's queue out of an open agent's document", () => {
    queueActions.push({ id: "q1", text: "for the leader", expanded: "for the leader" });
    openAgent();

    // Text typed here steers the agent; the leader's queued turn input never shows.
    expect(viewedThread().queued).toHaveLength(0);
  });

  it("shows the open agent's pending steers until its turn drains them", () => {
    openAgent();
    queueAgentSteer(AGENT_FORK, { text: "focus on the tests", blocks: [] });

    expect(viewedThread().queued.map((message) => message.text)).toEqual(["focus on the tests"]);

    drainAgentSteers(AGENT_FORK);
    expect(viewedThread().queued).toHaveLength(0);
  });

  it("reads the open agent's task list, never falling back to the leader's", () => {
    createTask({ subject: "leader work", description: "" });
    openAgent();

    // Falling back to the leader's list when the fork holds nothing is the leak.
    expect(viewedThread().tasks).toHaveLength(0);
  });

  it("returns every readout to the leader once the document closes", () => {
    queueActions.push({ id: "q1", text: "for the leader", expanded: "for the leader" });
    createTask({ subject: "leader work", description: "" });
    openAgent();
    dispatch({ type: "view/setViewingAgent", id: null });

    const thread = viewedThread();
    expect(thread.agent).toBeNull();
    expect(thread.broker.model).toBe("claude-opus-5");
    expect(thread.queued).toHaveLength(1);
    expect(thread.tasks).toHaveLength(1);
  });
});
