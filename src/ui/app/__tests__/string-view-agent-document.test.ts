import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clear as clearBackgroundTasks,
  removeTask,
  resetEmitThrottleForTests,
  setForkId,
  startTask,
} from "@/engine/background/tasks/background.ts";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewAgentDocument } from "@/ui/app/string-view-agent-document.ts";

const initialAppState = appStore.getState();
let workspace: string | undefined;

afterEach(() => {
  dispatch({ type: "view/setViewingAgent", id: null });
  appStore.setState(() => initialAppState);
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

const context = { requestRender: () => {}, pushFocus: () => {}, popFocus: () => {} };

function agentWithTranscript(): string {
  workspace = mkdtempSync(join(tmpdir(), "otherside-agent-doc-"));
  const sessionId = "parent-session";
  const forkId = "fork-1";
  const task = startTask({
    parentToolCallId: "call-1",
    agentName: "reviewer",
    agentId: "general-purpose",
    description: "audit the emitter",
    cwd: workspace,
    sessionId,
    isBackgrounded: true,
  });
  setForkId(task.id, forkId);

  const path = agentTranscriptPathForCwd(workspace, sessionId, forkId);
  mkdirSync(dirname(path), { recursive: true });
  const ts = new Date(0).toISOString();
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user_message", ts, content: "audit the emitter" }),
      JSON.stringify({ type: "assistant_message", ts, content: "the emitter drifts on settle" }),
      "",
    ].join("\n"),
  );
  return task.id;
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("StringViewAgentDocument", () => {
  it("is inert until a panel selection opens an agent", () => {
    const document = new StringViewAgentDocument();
    document.mount(context);

    expect(document.isActive()).toBe(false);
    expect(document.render(80)).toEqual([]);
    document.unmount();
  });

  it("renders the opened agent's own conversation", async () => {
    const taskId = agentWithTranscript();
    const document = new StringViewAgentDocument();
    document.mount(context);

    dispatch({ type: "view/setViewingAgent", id: taskId });
    await settle();

    expect(document.isActive()).toBe(true);
    // Settled history is committed to native scrollback; the live frame only
    // carries the unsettled tail.
    const rows = [...document.snapshotScrollback(80), ...document.render(80)]
      .map(stripAnsi)
      .join("\n");
    expect(rows).toContain("audit the emitter");
    expect(rows).toContain("the emitter drifts on settle");
    document.unmount();
  });

  it("closes when the selection returns to the main conversation", async () => {
    const taskId = agentWithTranscript();
    const document = new StringViewAgentDocument();
    document.mount(context);
    dispatch({ type: "view/setViewingAgent", id: taskId });
    await settle();

    dispatch({ type: "view/setViewingAgent", id: null });

    expect(document.isActive()).toBe(false);
    expect(document.render(80)).toEqual([]);
    document.unmount();
  });

  it("drops the view when the task it was showing is gone", async () => {
    const taskId = agentWithTranscript();
    const document = new StringViewAgentDocument();
    document.mount(context);
    dispatch({ type: "view/setViewingAgent", id: taskId });
    await settle();

    resetEmitThrottleForTests();
    removeTask(taskId);
    await settle();

    expect(appStore.getState().view.viewingAgentId).toBeNull();
    expect(document.isActive()).toBe(false);
    document.unmount();
  });
});
