import { describe, expect, it } from "bun:test";
import type { WorkflowPhaseSpec } from "@/engine/background/workflows/runtime/parser/types.ts";
import {
  buildMergedPhases,
  renderWorkflowHeader,
  tallyWorkflowAgentCounts,
} from "@/engine/background/workflows/runtime/progress/merge.ts";
import type {
  WorkflowAgentStatus,
  WorkflowPhaseStatus,
} from "@/engine/background/workflows/runtime/store/types.ts";

function agent(
  index: number,
  phaseTitle?: string,
  state: "start" | "done" | "error" = "done",
): WorkflowAgentStatus {
  return {
    type: "workflow_agent",
    index,
    label: `agent-${index}`,
    ...(phaseTitle ? { phaseTitle } : {}),
    state,
    startedAt: 1000,
    lastProgressAt: 5000,
    tokens: 100,
  };
}

function phase(index: number, title: string): WorkflowPhaseStatus {
  return { type: "workflow_phase", index, title };
}

function declared(index: number, title: string): WorkflowPhaseSpec {
  return { index, title };
}

describe("buildMergedPhases", () => {
  it("merges agents under their declared phase", () => {
    const merged = buildMergedPhases({
      workflowProgress: [phase(0, "Research"), agent(0, "Research")],
      phases: [declared(0, "Research")],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Research");
    expect(merged[0]!.doneCount).toBe(1);
    expect(merged[0]!.totalCount).toBe(1);
    expect(merged[0]!.status).toBe("done");
  });

  it("appends live groups not present in the declared phases", () => {
    const merged = buildMergedPhases({
      workflowProgress: [agent(0, "Unknown")],
      phases: [declared(0, "Research")],
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]!.title).toBe("Research");
    expect(merged[0]!.status).toBe("not-started");
    expect(merged[1]!.title).toBe("Unknown");
  });

  it("matches declared phases by prefix in either direction", () => {
    const merged = buildMergedPhases({
      workflowProgress: [agent(0, "Research")],
      phases: [declared(0, "Research phase")],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Research");
  });

  it("collapses unphased agents into a single synthetic group", () => {
    const merged = buildMergedPhases({
      workflowProgress: [agent(0), agent(1)],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Agents");
    expect(merged[0]!.totalCount).toBe(2);
  });

  it("reports a failed phase when any agent errored without stopping", () => {
    const merged = buildMergedPhases({
      workflowProgress: [agent(0, "Work", "error")],
      phases: [declared(0, "Work")],
    });
    expect(merged[0]!.status).toBe("failed");
  });
});

describe("tallyWorkflowAgentCounts", () => {
  it("aggregates across phases and respects the declared floor", () => {
    const merged = buildMergedPhases({
      workflowProgress: [agent(0, "A"), agent(1, "B")],
      phases: [declared(0, "A"), declared(1, "B")],
    });
    const counts = tallyWorkflowAgentCounts({ phases: merged, declaredAgentCount: 5 });
    expect(counts.totalAgents).toBe(5);
    expect(counts.doneAgents).toBe(2);
  });
});

describe("renderWorkflowHeader", () => {
  it("renders name, subtext, and stats with suffix", () => {
    const header = renderWorkflowHeader({
      name: "fleet",
      description: "desc",
      status: "completed",
      counts: { doneAgents: 3, totalAgents: 5 },
      elapsedMs: 125000,
    });
    expect(header.name).toBe("fleet");
    expect(header.subtext).toBe("desc");
    expect(header.stats).toContain("3/5 agents");
    expect(header.stats).toContain("done");
  });
});
