import { describe, expect, it } from "bun:test";
import type {
  WorkflowAgentStatus,
  WorkflowProgressItem,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { renderWorkflowDetail } from "@/ui/panels/workflows/detail.ts";
import type { WorkflowListItem } from "@/ui/panels/workflows/items.ts";

const WIDTH = 100;

function agent(overrides: Partial<WorkflowAgentStatus> = {}): WorkflowAgentStatus {
  return {
    type: "workflow_agent",
    index: 0,
    label: "auditor",
    phaseTitle: "Review",
    agentId: "agent-1",
    state: "done",
    startedAt: 0,
    lastProgressAt: 1000,
    tokens: 500,
    toolCalls: 2,
    ...overrides,
  };
}

function item(progress: WorkflowProgressItem[]): WorkflowListItem {
  return {
    id: "task-1",
    runId: "run-1",
    name: "Nightly audit",
    description: "checks the tree",
    status: "completed",
    agentCount: 1,
    totalTokens: 500,
    durationMs: 1000,
    startTime: 0,
    script: "",
    phases: [],
    workflowProgress: progress,
    live: false,
  };
}

function state(overrides: Partial<Parameters<typeof renderWorkflowDetail>[0]["state"]> = {}) {
  return {
    detailLevel: "phases" as const,
    phaseCursor: 0,
    agentCursor: 0,
    cardScroll: 0,
    expandedPrompts: new Set<string>(),
    agentFilter: "all" as const,
    ...overrides,
  };
}

/** The card shares the frame with a list, so a row's content sits between the last two borders. */
function paneContent(row: string): string {
  const cells = row.split("│");
  return cells.length >= 3 ? (cells[cells.length - 2] ?? "") : row;
}

/** An outcome long enough that the card cannot fit any terminal used here. */
const LONG_OUTCOME = Array.from({ length: 60 }, (_, index) => `outcome line ${index}`).join("\n");

/** Card rows actually on screen, counted by their own content. */
function visibleOutcomeRows(lines: string[]): number {
  return lines.map(stripAnsi).filter((row) => row.includes("outcome line ")).length;
}

describe("the agent card's height", () => {
  it("shows more of the card in a taller terminal", () => {
    const detailState = state({ detailLevel: "agent" });
    const workflow = item([agent({ resultPreview: LONG_OUTCOME })]);

    // Both heights are large enough that the frame's own clipping never engages, so
    // any difference here comes from the card's window and nothing else. A fixed
    // window would show the same number of rows in both.
    const shorter = renderWorkflowDetail({
      item: workflow,
      state: detailState,
      terminalRows: 60,
      width: WIDTH,
    });
    const taller = renderWorkflowDetail({
      item: workflow,
      state: detailState,
      terminalRows: 100,
      width: WIDTH,
    });

    expect(visibleOutcomeRows(shorter.lines)).toBeGreaterThan(0);
    expect(visibleOutcomeRows(taller.lines)).toBeGreaterThan(visibleOutcomeRows(shorter.lines));
  });

  it("keeps every row inside the terminal it was given", () => {
    for (const rows of [24, 30, 40]) {
      const rendered = renderWorkflowDetail({
        item: item([agent({ resultPreview: LONG_OUTCOME })]),
        state: state({ detailLevel: "agent" }),
        terminalRows: rows,
        width: WIDTH,
      });
      expect(rendered.lines.length).toBeLessThanOrEqual(rows);
    }
  });

  it("marks that rows are hidden when the card overflows", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent({ resultPreview: LONG_OUTCOME })]),
      state: state({ detailLevel: "agent" }),
      terminalRows: 24,
      width: WIDTH,
    });

    expect(rendered.lines.map(stripAnsi).join("\n")).toContain("more");
  });

  it("scrolls the card and reports the scroll it settled on", () => {
    const workflow = item([agent({ resultPreview: LONG_OUTCOME })]);
    const top = renderWorkflowDetail({
      item: workflow,
      state: state({ detailLevel: "agent" }),
      terminalRows: 30,
      width: WIDTH,
    });
    const scrolled = renderWorkflowDetail({
      item: workflow,
      state: state({ detailLevel: "agent", cardScroll: 5 }),
      terminalRows: 30,
      width: WIDTH,
    });

    expect(scrolled.cardScroll).toBe(5);
    expect(scrolled.lines).not.toEqual(top.lines);
  });

  it("clamps a scroll past the end back onto the card", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent({ resultPreview: LONG_OUTCOME })]),
      state: state({ detailLevel: "agent", cardScroll: 10_000 }),
      terminalRows: 30,
      width: WIDTH,
    });

    expect(rendered.cardScroll).toBeLessThan(10_000);
    expect(rendered.lines.length).toBeLessThanOrEqual(30);
  });

  it("leaves a card that already fits unscrolled", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent({ resultPreview: "short" })]),
      state: state({ detailLevel: "agent", cardScroll: 4 }),
      terminalRows: 60,
      width: WIDTH,
    });

    expect(rendered.cardScroll).toBe(0);
  });
});

describe("the detail's cursors", () => {
  it("clamps a phase cursor past the last phase", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent()]),
      state: state({ phaseCursor: 99 }),
      terminalRows: 40,
      width: WIDTH,
    });

    expect(rendered.phaseCursor).toBe(0);
  });

  it("says so when a workflow has no agents yet", () => {
    const rendered = renderWorkflowDetail({
      item: item([]),
      state: state(),
      terminalRows: 40,
      width: WIDTH,
    });

    expect(rendered.lines.map(stripAnsi).join("\n")).toContain("No agents yet.");
  });
});

describe("an agent's outcome", () => {
  /** Whatever follows the outcome header, with blank rows dropped. */
  function outcomeBody(lines: string[]): string[] {
    const rows = lines
      .map(stripAnsi)
      .map(paneContent)
      .map((row) => row.trim());
    return rows.slice(rows.indexOf("Outcome") + 1).filter((row) => row.length > 0);
  }

  it("says a skipped agent was skipped rather than heading an empty section", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent({ skipped: true, state: "start" })]),
      state: state({ detailLevel: "agent" }),
      terminalRows: 40,
      width: WIDTH,
    });

    const rows = rendered.lines
      .map(stripAnsi)
      .map(paneContent)
      .map((row) => row.trim());

    expect(rows).toContain("Outcome");
    expect(outcomeBody(rendered.lines)[0]).toBe("Skipped at your request.");
  });

  it("still reports what a finished agent returned", () => {
    const rendered = renderWorkflowDetail({
      item: item([agent({ resultPreview: "the audit found nothing" })]),
      state: state({ detailLevel: "agent" }),
      terminalRows: 40,
      width: WIDTH,
    });

    expect(outcomeBody(rendered.lines)[0]).toBe("the audit found nothing");
  });
});

describe("the phase level's two columns", () => {
  function agents(count: number): WorkflowProgressItem[] {
    return Array.from({ length: count }, (_, index) =>
      agent({ index, label: `auditor-${index}`, agentId: `agent-${index}` }),
    );
  }

  /** Body rows carry the panel's own indent, so the box is found past it. */
  function rendered(count: number, width: number) {
    return renderWorkflowDetail({
      item: item(agents(count)),
      state: state(),
      terminalRows: 40,
      width,
    })
      .lines.map(stripAnsi)
      .map((row) => row.trimStart());
  }

  it("names both columns in the rule that opens the box", () => {
    const top = rendered(2, WIDTH).find((row) => row.startsWith("╭")) ?? "";

    expect(top).toContain("Phases");
    expect(top).toContain("2 agents");
  });

  it("stands the selected phase's agents beside the phase list", () => {
    const lines = rendered(2, WIDTH);
    const interior = lines.filter((row) => row.startsWith("│"));
    const firstRow = interior[0] ?? "";

    // One interior row carries both columns, which is the point of the split.
    expect(firstRow).toContain("Review");
    expect(firstRow).toContain("auditor-0");
    expect(interior.join("\n")).toContain("auditor-1");
  });

  it("fills the terminal it was given, since nothing sits below it", () => {
    for (const rows of [24, 40, 60]) {
      const lines = renderWorkflowDetail({
        item: item(agents(2)),
        state: state(),
        terminalRows: rows,
        width: WIDTH,
      }).lines;

      expect(lines).toHaveLength(rows);
    }
  });

  it("holds the box open past the rows the columns fill", () => {
    const lines = rendered(2, WIDTH);
    const top = lines.findIndex((row) => row.startsWith("╭"));
    const bottom = lines.findIndex((row) => row.startsWith("╰"));

    expect(bottom - top).toBeGreaterThan(4);
  });

  it("stacks the columns instead when the frame is too narrow to split", () => {
    const lines = rendered(2, 60);

    expect(lines.some((row) => row.includes("┬"))).toBe(false);
    expect(lines.join("\n")).toContain("auditor-0");
  });
});
