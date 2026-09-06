import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAgentSteers, drainAgentSteers } from "@/engine/background/subagents/fork/steering.ts";
import { clear, setForkId, startTask } from "@/engine/background/tasks/background.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import type { ViewedAgentSubmitDeps } from "@/ui/app/dispatch/viewed-agent-submit.ts";
import { submitToViewedAgent } from "@/ui/app/dispatch/viewed-agent-submit.ts";

const emptyPasteStore = createPasteStore("sess-fixture");

function depsWith(overrides?: Partial<ViewedAgentSubmitDeps>): ViewedAgentSubmitDeps {
  return {
    // The steer path never touches the agent; a cast keeps the rig honest about it.
    agent: { deps: { session: { id: "sess-fixture", cwd: "/tmp/fixture" } } } as never,
    pasteStoreRef: { current: emptyPasteStore },
    showUndeliverable: () => {},
    ...overrides,
  };
}

function openViewedTask(input?: { forkId?: string }): string {
  const task = startTask({
    agentName: "fixture-agent",
    description: "fixture",
    parentToolCallId: "call-fixture",
  });
  if (input?.forkId !== undefined) setForkId(task.id, input.forkId);
  dispatch({ type: "view/setViewingAgent", id: task.id });
  return task.id;
}

beforeEach(() => {
  clear();
  dispatch({ type: "view/setViewingAgent", id: null });
});

afterEach(() => {
  clearAgentSteers("fork-fixture");
  clear();
  dispatch({ type: "view/setViewingAgent", id: null });
});

describe("submitToViewedAgent", () => {
  test("answers false while no agent document is open — the main conversation owns the text", async () => {
    expect(await submitToViewedAgent("hello", depsWith())).toBe(false);
  });

  test("steers a running viewed agent instead of the main conversation", async () => {
    openViewedTask({ forkId: "fork-fixture" });
    const routed = await submitToViewedAgent("adjust the plan", depsWith());
    expect(routed).toBe(true);
    const drained = drainAgentSteers("fork-fixture");
    expect(drained).toHaveLength(1);
    expect(drained[0]?.text).toBe("adjust the plan");
  });

  test("claims the text and reports when the viewed agent cannot receive it", async () => {
    openViewedTask();
    let reported: string | null = null;
    const routed = await submitToViewedAgent(
      "hello",
      depsWith({ showUndeliverable: (reason) => (reported = reason) }),
    );
    expect(routed).toBe(true);
    expect(reported).not.toBeNull();
  });
});
