import { afterEach, describe, expect, test } from "bun:test";
import {
  clear as clearBackgroundTasks,
  completeTask,
  get as getBackgroundTask,
  resetEmitThrottleForTests,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  enrollWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import {
  clearStopConfirm,
  setStopConfirmHoldForTests,
  stopConfirmStore,
} from "@/store/stop-confirm/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { StringContainer } from "@/terminal-runtime/string-view/component.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";
import { StringViewRoot } from "@/ui/app/string-view-root.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";
import { StringViewOverlayHost } from "@/ui/panels/string-view-overlay-host.ts";
import { StringViewDetailedTranscript } from "@/ui/transcript/string-view-detailed-transcript.ts";
import { StringViewTranscript } from "@/ui/transcript/string-view-transcript.ts";

const initialAppState = appStore.getState();

const mountedRoots: StringViewRoot[] = [];

function mountedRoot(): StringViewRoot {
  const transcript = new StringViewTranscript();
  const prompt = new StringViewPrompt();
  const promptScreen = new StringContainer();
  promptScreen.addChild(prompt);
  const root = new StringViewRoot(
    promptScreen,
    prompt,
    transcript,
    new StringViewDetailedTranscript(transcript),
    new StringViewAgentDocument(),
    new StringViewOverlayHost(),
  );
  root.mount({
    requestRender: () => {},
    pushFocus: () => {},
    popFocus: () => {},
    currentFocus: () => prompt,
  });
  mountedRoots.push(root);
  return root;
}

function runningAgent(callId: string, parentTaskId?: string): ReturnType<typeof startTask> {
  return startTask({
    parentToolCallId: callId,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    agentName: "sample-agent",
    agentId: "general-purpose",
    description: "sample work",
    isBackgrounded: true,
  });
}

function runningShell(callId: string): ReturnType<typeof startTask> {
  return startTask({
    parentToolCallId: callId,
    agentName: "shell",
    kind: "shell",
    description: "sleep 600",
    isBackgrounded: true,
  });
}

function runningWorkflow(id: string): void {
  enrollWorkflowTask({
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: "/tmp",
    sessionId: "session-1",
    workflowName: id,
    description: `${id} description`,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController: new AbortController(),
  } as WorkflowTaskLifecycle);
}

const X_KEY = { name: "x" } as KeyEventData;
const CTRL_X_KEY = { name: "x", ctrl: true } as KeyEventData;
const CTRL_K_KEY = { name: "k", ctrl: true } as KeyEventData;

afterEach(() => {
  for (const root of mountedRoots) root.unmount();
  mountedRoots.length = 0;
  setStopConfirmHoldForTests(3_000);
  clearStopConfirm();
  appStore.setState(() => initialAppState);
  clearBackgroundTasks();
  resetWorkflowTasksForTests();
  resetEmitThrottleForTests();
});

describe("stop-all chord", () => {
  test("reaches the fleet from the chat, with no row focused", () => {
    const agent = runningAgent("call-stop-all-from-chat");
    const shell = runningShell("call-stop-all-shell");
    const root = mountedRoot();

    expect(root.handleKey(CTRL_X_KEY)).toBe(true);
    expect(root.handleKey(CTRL_K_KEY)).toBe(true);

    expect(getBackgroundTask(agent.id)?.status).toBe("killed");
    // The hint promises agents; a background shell keeps running.
    expect(getBackgroundTask(shell.id)?.status).toBe("running");
  });

  test("a key that finishes neither half of the chord lets the prefix go", () => {
    const agent = runningAgent("call-stop-all-abandoned");
    const root = mountedRoot();

    root.handleKey(CTRL_X_KEY);
    root.handleKey({ name: "a", sequence: "a" } as KeyEventData);
    root.handleKey(CTRL_K_KEY);

    expect(getBackgroundTask(agent.id)?.status).toBe("running");
  });

  test("stops running agents outside the focused document tree", () => {
    const focusedRoot = runningAgent("call-stop-all-focused-root");
    const focusedChild = runningAgent("call-stop-all-focused-child", focusedRoot.id);
    const hiddenRoot = runningAgent("call-stop-all-hidden-root");
    dispatch({ type: "view/setViewingAgent", id: focusedChild.id });
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 2 });

    expect(root.handleKey(CTRL_X_KEY)).toBe(true);
    expect(root.handleKey(CTRL_K_KEY)).toBe(true);

    expect(getBackgroundTask(focusedRoot.id)?.status).toBe("killed");
    expect(getBackgroundTask(focusedChild.id)?.status).toBe("killed");
    expect(getBackgroundTask(hiddenRoot.id)?.status).toBe("killed");
  });
});

/**
 * The stop key is a two-stage gesture on an agent row: the first press stops
 * the run and arms the row, the second press closes it. Focus must follow the
 * rows: none left → back to the prompt (panel focus over an empty strip
 * swallows every printable key); some left → the selection clamps onto them.
 */
describe("two-stage stop on the focused agent row", () => {
  test("the first press stops the run, arms the row, and keeps focus on it", () => {
    const task = runningAgent("call-kill-focus-1");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);

    expect(getBackgroundTask(task.id)?.status).toBe("killed");
    expect(getBackgroundTask(task.id)?.stoppedByUser).toBe(true);
    expect(stopConfirmStore.getState()).toEqual({ taskId: task.id, justStopped: true });
    expect(appStore.getState().view.panelFocused).toBe(true);
  });

  test("the second press closes the row and returns focus to the prompt", () => {
    const task = runningAgent("call-kill-focus-2");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);
    expect(root.handleKey(X_KEY)).toBe(true);

    expect(getBackgroundTask(task.id)).toBeUndefined();
    expect(stopConfirmStore.getState().taskId).toBeNull();
    expect(appStore.getState().view.panelFocused).toBe(false);
  });

  test("a settled row arms without a stop and the second press closes it", () => {
    const task = runningAgent("call-kill-focus-3");
    runningAgent("call-kill-focus-3b");
    completeTask(task.id, { content: "done", isError: false });
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);
    expect(stopConfirmStore.getState()).toEqual({ taskId: task.id, justStopped: false });
    expect(root.handleKey(X_KEY)).toBe(true);

    expect(getBackgroundTask(task.id)).toBeUndefined();
    expect(appStore.getState().view.panelFocused).toBe(true);
  });

  test("closing an agent with a workflow still listed clamps the selection", () => {
    runningAgent("call-kill-focus-4");
    runningWorkflow("wf-kill-focus");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);
    expect(root.handleKey(X_KEY)).toBe(true);

    const view = appStore.getState().view;
    expect(view.panelFocused).toBe(true);
    expect(view.panelSelection).toBe(0);
  });

  test("a press on the main row does nothing", () => {
    runningAgent("call-kill-focus-5");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 0 });

    expect(root.handleKey(X_KEY)).toBe(false);

    const view = appStore.getState().view;
    expect(view.panelFocused).toBe(true);
    expect(view.panelSelection).toBe(0);
  });

  test("navigating to another row disarms the confirmation", () => {
    runningAgent("call-kill-focus-6");
    runningAgent("call-kill-focus-6b");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);
    expect(stopConfirmStore.getState().taskId).not.toBeNull();
    expect(root.handleKey({ name: "down" } as KeyEventData)).toBe(true);

    expect(stopConfirmStore.getState().taskId).toBeNull();
  });
});

/** Rows can also leave on their own — the reader must never stay on an empty strip. */
describe("reactive panel focus", () => {
  test("keeps the selected workflow when agent rows are inserted before it", () => {
    runningAgent("call-workflow-survivor-first");
    runningWorkflow("wf-survivor");
    mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 2 });

    resetEmitThrottleForTests();
    runningAgent("call-workflow-survivor-second");

    expect(appStore.getState().view.panelSelection).toBe(3);
  });

  test("the last agent finishing keeps its row and the panel focus until eviction", () => {
    const task = runningAgent("call-kill-focus-7");
    mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    // The start's emit leaves the throttle window open; reset so the
    // completion notifies its subscribers synchronously.
    resetEmitThrottleForTests();
    completeTask(task.id, { content: "done", isError: false });

    // The settled row stays on the strip — it is the door back to the run.
    expect(appStore.getState().view.panelFocused).toBe(true);

    resetEmitThrottleForTests();
    clearBackgroundTasks();
    expect(appStore.getState().view.panelFocused).toBe(false);
  });

  test("the hold expiring over the last stopped row keeps the settled row focused", async () => {
    setStopConfirmHoldForTests(10);
    runningAgent("call-kill-focus-8");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(X_KEY)).toBe(true);
    expect(appStore.getState().view.panelFocused).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stopConfirmStore.getState().taskId).toBeNull();
    expect(appStore.getState().view.panelFocused).toBe(true);
  });
});

describe("typing over an open agent document", () => {
  test("an insertable key releases the rows and falls through to the prompt", () => {
    const task = runningAgent("call-doc-typing-1");
    dispatch({ type: "view/setViewingAgent", id: task.id });
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey({ name: "h", sequence: "h" } as KeyEventData)).toBe(false);
    expect(appStore.getState().view.panelFocused).toBe(false);
    expect(appStore.getState().view.viewingAgentId).toBe(task.id);
  });

  test("without a document the rows still swallow typing", () => {
    runningAgent("call-doc-typing-2");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey({ name: "h", sequence: "h" } as KeyEventData)).toBe(true);
    expect(appStore.getState().view.panelFocused).toBe(true);
  });

  test("escape blurs the rows first and only then closes the document", () => {
    const task = runningAgent("call-doc-esc-1");
    dispatch({ type: "view/setViewingAgent", id: task.id });
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey({ name: "escape" } as KeyEventData)).toBe(true);
    expect(appStore.getState().view.panelFocused).toBe(false);
    expect(appStore.getState().view.viewingAgentId).toBe(task.id);
  });
});

const F_KEY = { name: "f", sequence: "f" } as KeyEventData;
const K_KEY = { name: "k", sequence: "k" } as KeyEventData;

/**
 * A focused row answers to two keys: Enter opens the document, x stops and then
 * closes. Every other letter is typing the rows hold back, so a stray press can
 * never open a document or end a run behind the reader.
 */
describe("letters carry no row action", () => {
  test("f is held back as typing and opens nothing", () => {
    const task = runningAgent("call-strip-foreground");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(F_KEY)).toBe(true);

    expect(appStore.getState().view.viewingAgentId).toBeNull();
    expect(appStore.getState().view.panelFocused).toBe(true);
    expect(getBackgroundTask(task.id)?.status).toBe("running");
  });

  test("k is held back as typing and stops nothing", () => {
    const task = runningAgent("call-strip-kill");
    runningAgent("call-strip-kill-sibling");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey(K_KEY)).toBe(true);

    expect(getBackgroundTask(task.id)?.status).toBe("running");
    expect(stopConfirmStore.getState().taskId).toBeNull();
  });

  test("Enter opens the selected agent's document and keeps the cursor on the rows", () => {
    const task = runningAgent("call-strip-enter-open");
    const root = mountedRoot();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });

    expect(root.handleKey({ name: "return" } as KeyEventData)).toBe(true);

    expect(appStore.getState().view.viewingAgentId).toBe(task.id);
    expect(appStore.getState().view.panelFocused).toBe(true);
    expect(getBackgroundTask(task.id)?.status).toBe("running");
  });
});
