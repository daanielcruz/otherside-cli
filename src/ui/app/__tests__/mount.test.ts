import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { projectThreadView } from "../mount.tsx";

const MAIN_STATE: BrokerState = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "max",
  fastMode: true,
  ultracode: true,
  permissionMode: "default",
};

function makeAgentTask(status: BackgroundTask["status"] = "running"): BackgroundTask {
  return {
    id: "agent-view",
    kind: "agent",
    parentToolCallId: "agent-call",
    agentName: "Verifier",
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    runGeneration: 0,
    runToken: "agent-view:0:test",
    lifecycleMode: "detached",
    terminalNotification: "pending",
    status,
    startedAt: 1,
    isBackgrounded: true,
    forkId: "agent-fork",
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 321,
    outputTokens: 45,
    notified: false,
  };
}

describe("thread view projection", () => {
  test("preserves main state and counters in the main view", () => {
    const projection = projectThreadView({
      state: MAIN_STATE,
      task: undefined,
      busy: true,
      inputTokens: 10_000,
      outputTokens: 2_000,
      contextTotal: 12_000,
    });

    expect(projection).toEqual({
      state: MAIN_STATE,
      busy: true,
      inputTokens: 10_000,
      outputTokens: 2_000,
      contextTotal: 12_000,
    });
    expect(projection.state).toBe(MAIN_STATE);
  });

  test("projects the viewed agent identity, activity, and token counters", () => {
    const projection = projectThreadView({
      state: MAIN_STATE,
      task: makeAgentTask(),
      busy: false,
      inputTokens: 10_000,
      outputTokens: 2_000,
      contextTotal: 12_000,
    });

    expect(projection.state).toEqual({
      ...MAIN_STATE,
      provider: "xai",
      model: "grok-4.5",
      effort: "high",
      ultracode: false,
    });
    expect(projection.busy).toBe(true);
    expect(projection.inputTokens).toBe(321);
    expect(projection.outputTokens).toBe(45);
    expect(projection.contextTotal).toBe(366);
  });

  test("does not inherit main busy state after the viewed agent finishes", () => {
    const projection = projectThreadView({
      state: MAIN_STATE,
      task: makeAgentTask("completed"),
      busy: true,
      inputTokens: 10_000,
      outputTokens: 2_000,
      contextTotal: 12_000,
    });

    expect(projection.busy).toBe(false);
    expect(projection.inputTokens).toBe(321);
    expect(projection.outputTokens).toBe(45);
  });
});
