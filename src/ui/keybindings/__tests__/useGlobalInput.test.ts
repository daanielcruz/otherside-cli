import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAgentSteers,
  pendingAgentSteerCount,
  queueAgentSteer,
} from "@/engine/background/subagents/fork/steering.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import {
  dispatchViewedAgentCancellation,
  type GlobalArrowNavigationState,
  nextGlobalArrowNavigation,
} from "../useGlobalInput.ts";

const TARGET_FORK_ID = "cancel-target-fork";
const OTHER_FORK_ID = "cancel-other-fork";

afterEach(() => {
  clearAgentSteers(TARGET_FORK_ID);
  clearAgentSteers(OTHER_FORK_ID);
});

function makeTask(input: {
  id: string;
  forkId: string;
  status?: BackgroundTask["status"];
}): BackgroundTask {
  return {
    id: input.id,
    kind: "agent",
    parentToolCallId: `call-${input.id}`,
    agentName: input.id,
    runGeneration: 0,
    runToken: `${input.id}:0:test`,
    lifecycleMode: "detached",
    terminalNotification: "pending",
    status: input.status ?? "running",
    startedAt: 1,
    isBackgrounded: true,
    forkId: input.forkId,
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    notified: false,
  };
}

function arrowState(
  overrides: Partial<GlobalArrowNavigationState> = {},
): GlobalArrowNavigationState {
  return {
    direction: "up",
    viewingAgent: true,
    bgTasksOpen: false,
    promptHasText: false,
    hasShellPill: false,
    panelHasRows: true,
    bgPillFocused: false,
    panelFocused: false,
    panelSelection: 0,
    panelMaxIndex: 2,
    ...overrides,
  };
}

function dispatch(input: {
  key: "ctrl-c" | "esc";
  viewingAgentId: string;
  tasks: BackgroundTask[];
  promptText?: string;
}): { promptText: string; leftView: number; stoppedTaskIds: string[] } {
  let promptText = input.promptText ?? "";
  let leftView = 0;
  const stoppedTaskIds: string[] = [];
  dispatchViewedAgentCancellation({
    key: input.key,
    viewingAgentId: input.viewingAgentId,
    tasks: input.tasks,
    promptText,
    setPromptText: (next) => {
      promptText = next;
    },
    leaveAgentView: () => {
      leftView += 1;
    },
    stopTask: (task) => stoppedTaskIds.push(task.id),
  });
  return { promptText, leftView, stoppedTaskIds };
}

describe("global arrow navigation", () => {
  test("first arrow in an agent view focuses the first panel row", () => {
    expect(nextGlobalArrowNavigation(arrowState())).toBe("focus-panel-first");
    expect(nextGlobalArrowNavigation(arrowState({ direction: "down" }))).toBe("focus-panel-first");
  });

  test("agent view keeps arrow ownership when the prompt has text", () => {
    expect(nextGlobalArrowNavigation(arrowState({ promptHasText: true }))).toBe(
      "focus-panel-first",
    );
    expect(nextGlobalArrowNavigation(arrowState({ direction: "down", promptHasText: true }))).toBe(
      "focus-panel-first",
    );
  });

  test("moves symmetrically between the view and panel rows", () => {
    expect(nextGlobalArrowNavigation(arrowState({ panelFocused: true, panelSelection: 0 }))).toBe(
      "blur-panel",
    );
    expect(
      nextGlobalArrowNavigation(
        arrowState({ direction: "down", panelFocused: true, panelSelection: 0 }),
      ),
    ).toBe("next-panel-row");
    expect(nextGlobalArrowNavigation(arrowState({ panelFocused: true, panelSelection: 1 }))).toBe(
      "previous-panel-row",
    );
  });

  test("keeps the first and last panel row boundaries", () => {
    expect(
      nextGlobalArrowNavigation(
        arrowState({ direction: "down", panelFocused: true, panelSelection: 2 }),
      ),
    ).toBe("handled");
    expect(nextGlobalArrowNavigation(arrowState({ panelFocused: true, panelSelection: 0 }))).toBe(
      "blur-panel",
    );
  });

  test("leaves main prompt history available for empty and filled prompts", () => {
    expect(nextGlobalArrowNavigation(arrowState({ viewingAgent: false }))).toBeNull();
    expect(
      nextGlobalArrowNavigation(arrowState({ viewingAgent: false, promptHasText: true })),
    ).toBeNull();
  });

  test("main prompt only enters panel rows on Down when empty", () => {
    expect(nextGlobalArrowNavigation(arrowState({ direction: "down", viewingAgent: false }))).toBe(
      "focus-panel-first",
    );
    expect(
      nextGlobalArrowNavigation(
        arrowState({ direction: "down", viewingAgent: false, promptHasText: true }),
      ),
    ).toBeNull();
  });
});

describe("viewed agent cancellation", () => {
  test("stops only the viewed running agent and restores only its queue", () => {
    const target = makeTask({ id: "target", forkId: TARGET_FORK_ID });
    const other = makeTask({ id: "other", forkId: OTHER_FORK_ID });
    queueAgentSteer(TARGET_FORK_ID, {
      text: "target queued",
      blocks: [{ type: "text", text: "target queued" }],
    });
    queueAgentSteer(OTHER_FORK_ID, {
      text: "other queued",
      blocks: [{ type: "text", text: "other queued" }],
    });

    const result = dispatch({
      key: "ctrl-c",
      viewingAgentId: target.id,
      tasks: [target, other],
    });

    expect(result).toEqual({
      promptText: "target queued",
      leftView: 0,
      stoppedTaskIds: [target.id],
    });
    expect(pendingAgentSteerCount(TARGET_FORK_ID)).toBe(0);
    expect(pendingAgentSteerCount(OTHER_FORK_ID)).toBe(1);
  });

  test("clears the viewed prompt before touching its task or queue", () => {
    const target = makeTask({ id: "target", forkId: TARGET_FORK_ID });
    queueAgentSteer(TARGET_FORK_ID, {
      text: "queued",
      blocks: [{ type: "text", text: "queued" }],
    });

    const result = dispatch({
      key: "esc",
      viewingAgentId: target.id,
      tasks: [target],
      promptText: "draft",
    });

    expect(result).toEqual({ promptText: "", leftView: 0, stoppedTaskIds: [] });
    expect(pendingAgentSteerCount(TARGET_FORK_ID)).toBe(1);
  });

  test("restores a finished agent queue without stopping or leaving", () => {
    const target = makeTask({
      id: "target",
      forkId: TARGET_FORK_ID,
      status: "completed",
    });
    queueAgentSteer(TARGET_FORK_ID, {
      text: "queued after finish",
      blocks: [{ type: "text", text: "queued after finish" }],
    });

    const result = dispatch({ key: "esc", viewingAgentId: target.id, tasks: [target] });

    expect(result).toEqual({
      promptText: "queued after finish",
      leftView: 0,
      stoppedTaskIds: [],
    });
    expect(pendingAgentSteerCount(TARGET_FORK_ID)).toBe(0);
  });

  test("leaves an idle agent view on escape", () => {
    const target = makeTask({
      id: "target",
      forkId: TARGET_FORK_ID,
      status: "completed",
    });

    expect(dispatch({ key: "esc", viewingAgentId: target.id, tasks: [target] })).toEqual({
      promptText: "",
      leftView: 1,
      stoppedTaskIds: [],
    });
  });
});
