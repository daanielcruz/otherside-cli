import { describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { type WorkflowDetailKeys, workflowDetailKey } from "@/ui/panels/workflows/detail-keys.ts";

function press(over: Partial<KeyEventData>): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: undefined,
    raw: undefined,
    isPasted: false,
    ...over,
  };
}

function typed(character: string): KeyEventData {
  return press({ name: character, sequence: character });
}

function standing(over: Partial<WorkflowDetailKeys> = {}): WorkflowDetailKeys {
  return {
    detailLevel: "phases",
    agent: undefined,
    phaseHasAgents: false,
    workflowActive: false,
    canResume: false,
    canControlAgent: false,
    promptExpandable: false,
    hasScript: false,
    ...over,
  };
}

const RUNNING_AGENT = { label: "review:bugs", agentId: "agent-1" };

describe("moving within where the reader stands", () => {
  test("the arrows step rows at every level", () => {
    expect(workflowDetailKey(press({ name: "down" }), standing())).toEqual({
      kind: "move-cursor",
      delta: 1,
    });
    expect(workflowDetailKey(press({ name: "up" }), standing({ detailLevel: "agent" }))).toEqual({
      kind: "move-cursor",
      delta: -1,
    });
  });

  test("j and k step rows in a list and scroll the card, which is a document", () => {
    expect(workflowDetailKey(typed("j"), standing({ detailLevel: "agents" }))).toEqual({
      kind: "move-cursor",
      delta: 1,
    });
    expect(workflowDetailKey(typed("k"), standing({ detailLevel: "agent" }))).toEqual({
      kind: "move-card",
      delta: -1,
    });
  });
});

describe("moving between levels", () => {
  test("going in from phases needs a phase with agents under it", () => {
    const enter = press({ name: "return" });
    expect(workflowDetailKey(enter, standing({ phaseHasAgents: true }))).toEqual({
      kind: "enter-agents",
    });
    expect(workflowDetailKey(enter, standing({ phaseHasAgents: false }))).toBeUndefined();
  });

  test("going in from the agent list opens the agent under the cursor", () => {
    const keys = standing({ detailLevel: "agents", agent: RUNNING_AGENT });
    expect(workflowDetailKey(press({ name: "right" }), keys)).toEqual({ kind: "enter-agent" });
  });

  test("the card is the last level, so going in unfolds the prompt or does nothing", () => {
    const withPrompt = standing({
      detailLevel: "agent",
      agent: RUNNING_AGENT,
      promptExpandable: true,
    });
    expect(workflowDetailKey(press({ name: "return" }), withPrompt)).toEqual({
      kind: "toggle-prompt",
      label: "review:bugs",
    });
    const withoutPrompt = standing({ detailLevel: "agent", agent: RUNNING_AGENT });
    expect(workflowDetailKey(press({ name: "return" }), withoutPrompt)).toBeUndefined();
  });

  test("either leaving key steps back out", () => {
    expect(workflowDetailKey(press({ name: "escape" }), standing())).toEqual({ kind: "back" });
    expect(workflowDetailKey(press({ name: "left" }), standing())).toEqual({ kind: "back" });
  });
});

describe("acting on the run", () => {
  test("space pauses a running workflow and resumes a paused one", () => {
    expect(workflowDetailKey(press({ sequence: " " }), standing({ workflowActive: true }))).toEqual(
      {
        kind: "pause",
      },
    );
    expect(workflowDetailKey(press({ sequence: " " }), standing({ canResume: true }))).toEqual({
      kind: "resume",
    });
    expect(workflowDetailKey(press({ sequence: " " }), standing())).toBeUndefined();
  });

  test("stopping is offered at the phase level of a running run, and nowhere else", () => {
    expect(workflowDetailKey(typed("x"), standing({ workflowActive: true }))).toEqual({
      kind: "stop",
    });
    expect(
      workflowDetailKey(typed("x"), standing({ workflowActive: true, detailLevel: "agent" })),
    ).toBeUndefined();
  });

  test("p unfolds the prompt on a card and pauses everywhere else", () => {
    const onCard = standing({
      detailLevel: "agent",
      agent: RUNNING_AGENT,
      promptExpandable: true,
      workflowActive: true,
    });
    expect(workflowDetailKey(typed("p"), onCard)).toEqual({
      kind: "toggle-prompt",
      label: "review:bugs",
    });
    expect(workflowDetailKey(typed("p"), standing({ workflowActive: true }))).toEqual({
      kind: "pause",
    });
  });

  test("the filter belongs to the agent list", () => {
    expect(workflowDetailKey(typed("f"), standing({ detailLevel: "agents" }))).toEqual({
      kind: "cycle-filter",
    });
    expect(workflowDetailKey(typed("f"), standing())).toBeUndefined();
  });
});

describe("acting on the agent under the cursor", () => {
  test("retry and skip reach a running agent, and no one else", () => {
    const controllable = standing({
      detailLevel: "agent",
      agent: RUNNING_AGENT,
      canControlAgent: true,
    });
    expect(workflowDetailKey(typed("r"), controllable)).toEqual({
      kind: "retry-agent",
      agentId: "agent-1",
    });
    expect(workflowDetailKey(typed("s"), controllable)).toEqual({
      kind: "skip-agent",
      agentId: "agent-1",
    });
    expect(workflowDetailKey(typed("r"), standing({ agent: RUNNING_AGENT }))).toBeUndefined();
  });

  test("skipping an agent claims s first, so saving is what it means elsewhere", () => {
    expect(workflowDetailKey(typed("s"), standing({ hasScript: true }))).toEqual({ kind: "save" });
    // A run with no script has nothing to save, so the key means nothing here.
    expect(workflowDetailKey(typed("s"), standing())).toBeUndefined();
  });
});
