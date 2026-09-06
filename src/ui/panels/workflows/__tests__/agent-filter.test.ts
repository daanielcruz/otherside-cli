import { describe, expect, it } from "bun:test";
import type { WorkflowAgentStatus } from "@/engine/background/workflows/runtime/store/types.ts";
import {
  AGENT_FILTER_ORDER,
  agentFilterLabel,
  filterAgents,
  nextAgentFilter,
} from "@/ui/panels/workflows/agent-filter.ts";
import { agentIdleSeconds, agentStatusLabel } from "@/ui/panels/workflows/items.ts";

const NOW = 1_000_000;

function agent(overrides: Partial<WorkflowAgentStatus> = {}): WorkflowAgentStatus {
  return {
    type: "workflow_agent",
    index: 0,
    label: "auditor",
    state: "start",
    queuedAt: NOW - 5_000,
    startedAt: NOW - 4_000,
    lastProgressAt: NOW,
    ...overrides,
  };
}

/** An agent that entered the queue and never got a slot: no start time at all. */
function waitingAgent(): WorkflowAgentStatus {
  const { startedAt: _unused, ...waiting } = agent();
  return waiting;
}

describe("a waiting agent is not a running one", () => {
  it("reads as queued while it holds no start time", () => {
    expect(agentStatusLabel({ agent: waitingAgent(), workflowActive: true })).toBe("queued");
  });

  it("reads as running once a slot granted it a start time", () => {
    expect(agentStatusLabel({ agent: agent(), workflowActive: true })).toBe("running");
  });

  it("still reads as interrupted when the workflow itself stopped", () => {
    expect(agentStatusLabel({ agent: waitingAgent(), workflowActive: false })).toBe("interrupted");
  });
});

describe("the idle badge", () => {
  it("stays silent until the silence is long enough to mean something", () => {
    const busy = agent({ lastProgressAt: NOW - 29_000 });

    expect(agentIdleSeconds(busy, "running", NOW)).toBeNull();
  });

  it("reports the silence once it reaches the threshold", () => {
    const quiet = agent({ lastProgressAt: NOW - 30_000 });

    expect(agentIdleSeconds(quiet, "running", NOW)).toBe(30);
  });

  it("is not a question worth asking about an agent that already finished", () => {
    const finished = agent({ state: "done", lastProgressAt: NOW - 600_000 });

    expect(agentIdleSeconds(finished, "done", NOW)).toBeNull();
  });
});

describe("cycling the agent filter", () => {
  const running = agent({ index: 1 });
  const failed = agent({ index: 2, state: "error" });

  it("skips a status no agent in the phase carries", () => {
    // Only running and failed are present, so the cycle never offers queued or done.
    const first = nextAgentFilter({
      current: "all",
      agents: [running, failed],
      workflowActive: true,
    });
    const second = nextAgentFilter({
      current: first,
      agents: [running, failed],
      workflowActive: true,
    });
    const third = nextAgentFilter({
      current: second,
      agents: [running, failed],
      workflowActive: true,
    });

    expect(first).toBe("running");
    expect(second).toBe("failed");
    expect(third).toBe("all");
  });

  it("comes to rest on all when the phase holds nothing", () => {
    expect(nextAgentFilter({ current: "all", agents: [], workflowActive: true })).toBe("all");
  });

  it("narrows the list to the chosen status and back", () => {
    const agents = [running, failed];

    expect(filterAgents({ agents, filter: "failed", workflowActive: true })).toEqual([failed]);
    expect(filterAgents({ agents, filter: "all", workflowActive: true })).toEqual(agents);
  });

  it("names an active filter and leaves the whole list unnamed", () => {
    expect(agentFilterLabel("all")).toBeUndefined();
    expect(agentFilterLabel("done")).toBe("completed");
  });

  it("leads with all so one press always returns to the whole list", () => {
    expect(AGENT_FILTER_ORDER[0]).toBe("all");
  });
});
