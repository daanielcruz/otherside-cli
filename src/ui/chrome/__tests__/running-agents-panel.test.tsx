import { describe, expect, it } from "bun:test";
import { clearAgentSteers, queueAgentSteer } from "@/engine/background/subagents/fork/steering.ts";
import { buildPanelTree } from "@/engine/background/tasks/panel-tree.ts";
import { clamp } from "@/kernel/std/math.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { cellAtIndex, type Screen } from "@/terminal-runtime/paint/cell-grid.ts";
import { paintToTerminal } from "@/terminal-runtime/paint/screen-diff.ts";
import { TerminalSizeContext } from "@/terminal-runtime/react/dimensions-context.tsx";
import {
  panelRowAllocation,
  panelSelectionFor,
  panelWindowStart,
  RunningAgentsPanel,
  remapPanelSelectionForAgentCountChange,
  runningPanelHint,
} from "@/ui/chrome/running-agents-panel.tsx";
import { StatusBar } from "@/ui/chrome/status/bar.tsx";
import { Statusline } from "@/ui/chrome/status/line.tsx";

const WIDTH = 100;
const NOW = 1_000_000;
const VIEWED_BULLET = process.platform === "darwin" ? "⏺" : "●";

const yoloState: BrokerState = {
  provider: "codex",
  model: "gpt-5.5",
  effort: null,
  fastMode: false,
  permissionMode: "yolo",
};

const agent = {
  id: "agent-1",
  kind: "agent",
  status: "running",
  agentName: "Verifier",
  description: "Verify tier fallback fix",
  cwd: "/tmp",
  sessionId: "test",
  startedAt: NOW - 20_000,
  inputTokens: 0,
  outputTokens: 0,
  actions: [],
} as never;

const workflow = {
  id: "wf-1",
  kind: "workflow",
  status: "running",
  title: "socket-close-retry-audit",
  workflowName: "socket-close-retry-audit",
  description: "Audit provider HTTP/SSE/socket retry classification",
  workflowRunId: "wf-test",
  startedAt: NOW - 30_000,
  agentCount: 0,
  completedAgents: 0,
  failedAgents: 0,
  workflowProgress: [],
  logs: [],
  totalTokens: 0,
  parentToolCallId: "tool-1",
} as never;

function makeWorkflows(count: number): never[] {
  return Array.from({ length: count }, (_, i) => ({
    ...(workflow as unknown as Record<string, unknown>),
    id: `wf-${i}`,
    workflowRunId: `wf-${i}`,
    workflowName: `Flow ${String(i).padStart(2, "0")}`,
    title: `Flow ${String(i).padStart(2, "0")}`,
    description: `Workflow task ${i}`,
    startedAt: NOW - i * 1000,
    totalTokens: 14_800 + i,
  })) as never[];
}

function makeAgents(count: number): never[] {
  return Array.from({ length: count }, (_, i) => ({
    ...(agent as unknown as Record<string, unknown>),
    id: `agent-${i}`,
    agentName: `IdleAgent-${String(i).padStart(2, "0")}`,
    description: `Idle task ${i}`,
  })) as never[];
}

function renderRows(panelHint?: string): string[] {
  const el = (
    <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
      <StatusBar state={yoloState} panelHint={panelHint} />
      <RunningAgentsPanel
        agents={[agent]}
        workflows={[workflow]}
        selection={undefined}
        focusInPanel={false}
        viewingAgentId={undefined}
        mainLlmBusy={true}
      />
    </TerminalSizeContext.Provider>
  );
  const { screen } = paintToTerminal(el, WIDTH);
  return screenToRows(screen);
}

function renderStatusRows(tokensWarning?: {
  message: string;
  severity: "warning" | "error";
}): string[] {
  const el = (
    <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
      <Statusline
        state={yoloState}
        sessionId="test-session"
        version="test"
        cwd="/tmp"
        refreshKey="test"
        totalTokens={179_933}
        tokensWarning={tokensWarning}
      />
      <StatusBar state={yoloState} />
    </TerminalSizeContext.Provider>
  );
  return screenToRows(paintToTerminal(el, WIDTH).screen);
}

function screenToRows(screen: Screen): string[] {
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAtIndex(screen, y * screen.width + x);
      line += cell.char.length > 0 ? cell.char : " ";
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

describe("running agents footer hints", () => {
  it("keeps the permission chip when the running panel is not focused", () => {
    const rows = renderRows();
    const rendered = rows.join("\n");
    expect(rendered).toContain("yolo mode on");
    expect(rendered).toContain("shift+tab to cycle");
    expect(rendered).not.toContain("↑/↓ to select");
  });

  it("replaces the permission chip with contextual panel hints", () => {
    const hint = runningPanelHint(true, undefined, workflow);
    const rows = renderRows(hint);
    const rendered = rows.join("\n");
    expect(rendered).toContain("enter to view · x to pause");
    expect(rendered).not.toContain("yolo mode on");
    expect(rendered).not.toContain("↑/↓ to select");
  });

  it("puts quota warnings in the token-counter slot without hiding permissions", () => {
    const warning = "[Codex] 73% Weekly · resets 14:30";
    const takeover = renderStatusRows({ message: warning, severity: "warning" }).join("\n");
    expect(takeover).toContain(warning);
    expect(takeover).not.toContain("179933 tokens");
    expect(takeover).toContain("yolo mode on");

    const restored = renderStatusRows().join("\n");
    expect(restored).toContain("179933 tokens");
    expect(restored).not.toContain(warning);
    expect(restored).toContain("yolo mode on");
  });
});

describe("running-agents-panel capacity", () => {
  it("caps both namespaces at five rows while the main LLM streams", () => {
    expect(panelRowAllocation(100, true, 20, 20)).toEqual({ agentRows: 5, workflowRows: 5 });
  });

  it("uses more than five rows at a tall idle terminal", () => {
    const allocation = panelRowAllocation(40, false, 20, 0);
    expect(allocation.agentRows).toBeGreaterThan(5);
    expect(allocation.workflowRows).toBe(0);

    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 40 }}>
        <RunningAgentsPanel
          agents={makeAgents(30)}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={false}
        />
      </TerminalSizeContext.Provider>
    );
    const rendered = screenToRows(paintToTerminal(el, WIDTH).screen).join("\n");
    expect(rendered).toContain("IdleAgent-05");
  });

  it("keeps short idle terminals within the safe shared budget", () => {
    const allocation = panelRowAllocation(12, false, 20, 20);
    expect(allocation.agentRows + allocation.workflowRows).toBe(0);
  });

  it("shares idle capacity between agents and workflows", () => {
    const allocation = panelRowAllocation(40, false, 20, 20);
    expect(allocation.agentRows).toBeGreaterThan(0);
    expect(allocation.workflowRows).toBeGreaterThan(0);
    expect(allocation.agentRows + allocation.workflowRows).toBeLessThanOrEqual(28);
  });

  it("clamps and slides selection windows when capacity changes", () => {
    expect(panelWindowStart(7, 2, 20, 10)).toBe(2);
    expect(panelWindowStart(2, 19, 20, 10)).toBe(10);
    expect(panelWindowStart(9, -1, 3, 10)).toBe(0);
  });
});

describe("running-agents-panel states", () => {
  it("uses the reference circle glyphs for viewed and unfocused rows", () => {
    const rows = renderRows();
    const rendered = rows.join("\n");
    expect(rendered).toContain(`${VIEWED_BULLET} main`);
    expect(rendered).toContain("○ Verifier");
    expect(rendered).not.toContain("◯");
  });

  it("renders a killed agent task as stopped with bullet and textual indicator", () => {
    const killedAgent = {
      ...(agent as unknown as Record<string, unknown>),
      status: "killed",
      endedAt: NOW,
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[killedAgent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");
    expect(rendered).not.toContain("stopped");
    expect(rendered).not.toContain("failed");
    expect(rendered).toContain("20s");
  });

  it("renders workflow agent counts without a done suffix", () => {
    const completedWorkflow = {
      ...(workflow as unknown as Record<string, unknown>),
      status: "completed",
      endedAt: NOW,
      agentCount: 5,
      workflowProgress: [
        {
          type: "workflow_agent",
          index: 0,
          label: "agent-0",
          state: "done",
          startedAt: NOW - 30_000,
          lastProgressAt: NOW,
        },
        {
          type: "workflow_agent",
          index: 1,
          label: "agent-1",
          state: "done",
          startedAt: NOW - 30_000,
          lastProgressAt: NOW,
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "agent-2",
          state: "done",
          startedAt: NOW - 30_000,
          lastProgressAt: NOW,
        },
      ],
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[]}
          workflows={[completedWorkflow]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");
    expect(rendered).toContain("3/5 agents");
    expect(rendered).not.toContain("agents done");
    expect(rendered).toContain("30s");
  });

  it("renders a running agent without a waiting label", () => {
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[agent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");
    expect(rendered).not.toContain("waiting");
    expect(rendered).toContain("Verifier");
  });

  it("renders queued steering on the running agent row", () => {
    const forkId = "fork-panel-queued";
    queueAgentSteer(forkId, {
      text: "steer",
      blocks: [{ type: "text", text: "steer" }],
    });
    const queuedAgent = {
      ...(agent as unknown as Record<string, unknown>),
      forkId,
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[queuedAgent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    expect(screenToRows(screen).join("\n")).toContain("1 queued");
    clearAgentSteers(forkId);
  });

  it("renders a completed agent task without an idle word", () => {
    const completedAgent = {
      ...(agent as unknown as Record<string, unknown>),
      status: "completed",
      endedAt: NOW,
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[completedAgent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");
    expect(rendered).not.toContain("idle");
    expect(rendered).toContain("○ Verifier");
    expect(rendered).toContain("20s");
  });

  it("computes panel tree visibility and transitive hidden counts correctly", () => {
    const parentTask = {
      id: "parent",
      kind: "agent",
      status: "running",
      agentName: "ParentAgent",
      description: "Parent agent task",
      startedAt: NOW,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;

    const otherRootTask = {
      id: "other-root",
      kind: "agent",
      status: "running",
      agentName: "OtherRootAgent",
      description: "Unrelated root agent task",
      startedAt: NOW + 500,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;

    const childTask = {
      id: "child",
      kind: "agent",
      status: "running",
      parentTaskId: "parent",
      agentName: "ChildAgent",
      description: "Child agent task",
      startedAt: NOW + 1000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;

    const siblingTask = {
      id: "sibling",
      kind: "agent",
      status: "running",
      parentTaskId: "parent",
      agentName: "SiblingAgent",
      description: "Sibling agent task",
      startedAt: NOW + 1500,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;

    const grandchildTask = {
      id: "grandchild",
      kind: "agent",
      status: "running",
      parentTaskId: "child",
      agentName: "GrandchildAgent",
      description: "Grandchild agent task",
      startedAt: NOW + 2000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;

    const tasks = [parentTask, otherRootTask, childTask, siblingTask, grandchildTask];

    // 1. focusedTaskId=undefined → only roots visible; parents carry transitiveHiddenCount of ALL descendants
    const tree1 = buildPanelTree(tasks, undefined);
    expect(tree1.orderedVisibleNodes.map((n) => n.task.id)).toEqual(["parent", "other-root"]);
    expect(tree1.orderedVisibleNodes[0]?.transitiveHiddenCount).toBe(3); // child + sibling + grandchild
    expect(tree1.orderedVisibleNodes[1]?.transitiveHiddenCount).toBe(0);

    // 2. focused on a nested (depth-2) task → ancestor chain + siblings of focused + children of focused;
    //    unrelated roots NOT visible; ancestor-chain rows (including focused) have transitiveHiddenCount 0
    const tree2 = buildPanelTree(tasks, "child");
    // DFS order: parent → child → grandchild → sibling
    expect(tree2.orderedVisibleNodes.map((n) => n.task.id)).toEqual([
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
    expect(tree2.orderedVisibleNodes.map((n) => n.task.id)).not.toContain("other-root");
    expect(tree2.orderedVisibleNodes[0]?.transitiveHiddenCount).toBe(0); // ancestor chain suppressed
    expect(tree2.orderedVisibleNodes[1]?.transitiveHiddenCount).toBe(0); // focused suppressed
    expect(tree2.orderedVisibleNodes[2]?.transitiveHiddenCount).toBe(0); // grandchild has no descendants
    expect(tree2.orderedVisibleNodes[3]?.transitiveHiddenCount).toBe(0); // sibling has no descendants

    // 3. focused on a root task → all roots visible + children of that root; ancestor badge suppressed
    const tree3 = buildPanelTree(tasks, "parent");
    expect(tree3.orderedVisibleNodes.map((n) => n.task.id)).toEqual([
      "parent",
      "child",
      "sibling",
      "other-root",
    ]);
    expect(tree3.orderedVisibleNodes[0]?.transitiveHiddenCount).toBe(0); // focused root on ancestor chain
    expect(tree3.orderedVisibleNodes[1]?.transitiveHiddenCount).toBe(1); // grandchild still hidden
    expect(tree3.orderedVisibleNodes[2]?.transitiveHiddenCount).toBe(0);
    expect(tree3.orderedVisibleNodes[3]?.transitiveHiddenCount).toBe(0);
  });

  it("renders agentConnector indent one level shallower (depth-2 has no leading spaces)", () => {
    const depth2Last = {
      id: "d2-last",
      kind: "agent",
      status: "running",
      agentName: "DepthTwoLast",
      description: "depth two last sibling",
      startedAt: NOW,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      depth: 2,
      hasLaterSibling: false,
    } as never;
    const depth2Mid = {
      id: "d2-mid",
      kind: "agent",
      status: "running",
      agentName: "DepthTwoMid",
      description: "depth two mid sibling",
      startedAt: NOW + 1,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      depth: 2,
      hasLaterSibling: true,
    } as never;
    const depth3Last = {
      id: "d3-last",
      kind: "agent",
      status: "running",
      agentName: "DepthThreeLast",
      description: "depth three last sibling",
      startedAt: NOW + 2,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      depth: 3,
      hasLaterSibling: false,
    } as never;

    const depth1Root = {
      id: "d1-root",
      kind: "agent",
      status: "running",
      agentName: "DepthOneRoot",
      description: "depth one root",
      startedAt: NOW - 1,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      depth: 1,
      hasLaterSibling: false,
    } as never;

    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[depth1Root, depth2Mid, depth2Last, depth3Last]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);

    const midRow = rows.find((row) => row.includes("DepthTwoMid"));
    const lastRow = rows.find((row) => row.includes("DepthTwoLast"));
    const deepRow = rows.find((row) => row.includes("DepthThreeLast"));
    expect(midRow).toBeDefined();
    expect(lastRow).toBeDefined();
    expect(deepRow).toBeDefined();

    // prefix is "  ", then connector: depth-2 → "├ "/"└ " (2 chars); depth-3 → "  └ " (4 chars)
    expect(midRow).toContain("  ├ ○ DepthTwoMid");
    expect(lastRow).toContain("  └ ○ DepthTwoLast");
    expect(deepRow).toContain("    └ ○ DepthThreeLast");
    // depth-2 must not carry the old extra indent ("    ├" / "    └")
    expect(midRow).not.toMatch(/ {4}├/);
    expect(lastRow).not.toMatch(/ {4}└/);
  });

  it("limits workflow rows to five and shows a lower more arrow", () => {
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[]}
          workflows={makeWorkflows(13)}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");

    expect(rendered).toContain("Flow 00");
    expect(rendered).toContain("Flow 04");
    expect(rendered).not.toContain("Flow 05");
    expect(rendered).not.toContain("↑");
    expect(rendered).toContain("↓ 8 more");
  });

  it("centers workflow rows on selection and shows an upper more arrow", () => {
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[]}
          workflows={makeWorkflows(15)}
          selection={{ namespace: "workflows", index: 14 }}
          focusInPanel={true}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);
    const rendered = rows.join("\n");

    const moreRows = rows.filter((row) => row.includes("more"));
    expect(moreRows).toHaveLength(1);
    expect(moreRows[0]).toContain("↑ 10 more");
    expect(rendered).toContain("Flow 10");
    expect(rendered).toContain("Flow 14");
    expect(rendered).not.toContain("Flow 09");
  });

  it("slides the 5-row window by its edges, never recentering", () => {
    // Render 10 agents
    const agents = Array.from({ length: 10 }, (_, i) => ({
      id: `agent-${i}`,
      kind: "agent",
      status: "running",
      agentName: `Agent-${i}`,
      description: `Task ${i}`,
      startedAt: NOW + i * 1000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    })) as never[];

    const paintWithSelection = (index: number) => {
      const el = (
        <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
          <RunningAgentsPanel
            agents={agents}
            workflows={[]}
            selection={{ namespace: "agents", index }}
            focusInPanel={true}
            viewingAgentId={undefined}
            mainLlmBusy={true}
          />
        </TerminalSizeContext.Provider>
      );
      const { screen } = paintToTerminal(el, WIDTH);
      return screenToRows(screen).join("\n");
    };

    // Fresh mount, selection inside the initial window: window stays at the top.
    const mid = paintWithSelection(5); // agent idx 4 = last row of window 0..4
    expect(mid).toContain("Agent-0");
    expect(mid).toContain("Agent-4");
    expect(mid).not.toContain("Agent-5");
    expect(mid).not.toContain("↑");
    expect(mid).toContain("↓ 5 more");

    // Fresh mount, selection below the window: slide just enough to include it
    // as the bottom row (never centered).
    const bottom = paintWithSelection(10); // agent idx 9 -> window 5..9
    expect(bottom).toContain("Agent-5");
    expect(bottom).toContain("Agent-9");
    expect(bottom).not.toContain("Agent-4");
    expect(bottom).toContain("↑ 5 more");
    expect(bottom).not.toContain("↓");
  });

  it("keeps the hidden-count suffix on the same line as a truncated long name", () => {
    const longNameAgent = {
      id: "agent-long",
      kind: "agent",
      status: "running",
      agentName: "GeneralPurposeInvestigationAgentWithAVeryLongName",
      description: "Track % compact vs trigger",
      startedAt: NOW - 5_000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      transitiveHiddenCount: 1,
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[longNameAgent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);

    const suffixRows = rows.filter((row) => row.includes("(+1)"));
    expect(suffixRows).toHaveLength(1);
    expect(suffixRows[0]).not.toBe("(+1)");
    expect(suffixRows[0]?.trim().startsWith("(+1)")).toBe(false);
    expect(suffixRows[0]).toContain("Track % compact vs trigger");
  });

  it("aligns the description column at the same x for every row regardless of a hidden-count suffix", () => {
    const shortAgent = {
      id: "agent-short",
      kind: "agent",
      status: "running",
      agentName: "Short",
      description: "Short description",
      startedAt: NOW - 5_000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as never;
    const suffixedAgent = {
      id: "agent-suffixed",
      kind: "agent",
      status: "running",
      agentName: "AlsoShort",
      description: "Suffixed description",
      startedAt: NOW - 4_000,
      actions: [],
      inputTokens: 0,
      outputTokens: 0,
      transitiveHiddenCount: 2,
    } as never;
    const el = (
      <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 20 }}>
        <RunningAgentsPanel
          agents={[shortAgent, suffixedAgent]}
          workflows={[]}
          selection={undefined}
          focusInPanel={false}
          viewingAgentId={undefined}
          mainLlmBusy={true}
        />
      </TerminalSizeContext.Provider>
    );
    const { screen } = paintToTerminal(el, WIDTH);
    const rows = screenToRows(screen);

    const shortRow = rows.find((row) => row.includes("Short description"));
    const suffixedRow = rows.find((row) => row.includes("Suffixed description"));
    expect(shortRow).toBeDefined();
    expect(suffixedRow).toBeDefined();
    expect(shortRow?.indexOf("Short description")).toBe(
      suffixedRow?.indexOf("Suffixed description"),
    );
  });
});

describe("panel selection navigation", () => {
  it("reserves index 0 for main and offsets workflows past the agent range", () => {
    expect(panelSelectionFor(0, 3)).toEqual({ namespace: "agents", index: 0 });
    expect(panelSelectionFor(3, 3)).toEqual({ namespace: "agents", index: 3 });
    expect(panelSelectionFor(4, 3)).toEqual({ namespace: "workflows", index: 0 });
    expect(panelSelectionFor(2, 0)).toEqual({ namespace: "workflows", index: 2 });
  });

  it("without a fix, a raw selection resolves to a different workflow when agentCount changes", () => {
    const withoutAgents = panelSelectionFor(4, 0);
    const withOneAgent = panelSelectionFor(4, 1);
    expect(withoutAgents).toEqual({ namespace: "workflows", index: 4 });
    expect(withOneAgent).toEqual({ namespace: "workflows", index: 2 });
    expect(withoutAgents.index).not.toBe(withOneAgent.index);
  });

  it("remapPanelSelectionForAgentCountChange keeps the same workflow selected when an agent appears", () => {
    const rawSelection = 4;
    const beforeIndex = panelSelectionFor(rawSelection, 0).index;
    const remapped = remapPanelSelectionForAgentCountChange(rawSelection, 0, 1);
    const afterIndex = panelSelectionFor(remapped, 1);
    expect(afterIndex).toEqual({ namespace: "workflows", index: beforeIndex });
  });

  it("remapPanelSelectionForAgentCountChange keeps the same workflow selected when the only agent disappears", () => {
    const rawSelection = 3;
    const beforeIndex = panelSelectionFor(rawSelection, 1).index;
    const remapped = remapPanelSelectionForAgentCountChange(rawSelection, 1, 0);
    const afterIndex = panelSelectionFor(remapped, 0);
    expect(afterIndex).toEqual({ namespace: "workflows", index: beforeIndex });
  });

  it("remapPanelSelectionForAgentCountChange keeps the same workflow selected across agent-count deltas", () => {
    const rawSelection = 6;
    const beforeIndex = panelSelectionFor(rawSelection, 2).index;
    const remapped = remapPanelSelectionForAgentCountChange(rawSelection, 2, 4);
    const afterIndex = panelSelectionFor(remapped, 4);
    expect(afterIndex).toEqual({ namespace: "workflows", index: beforeIndex });
  });

  it("remapPanelSelectionForAgentCountChange leaves agent/main selections untouched", () => {
    expect(remapPanelSelectionForAgentCountChange(0, 1, 2)).toBe(0);
    expect(remapPanelSelectionForAgentCountChange(1, 1, 2)).toBe(1);
    expect(remapPanelSelectionForAgentCountChange(5, 3, 3)).toBe(5);
  });

  it("keeps a selected workflow row visible within its window at both list edges", () => {
    const total = 15;
    const firstStart = clamp(0 - 2, 0, Math.max(0, total - 5));
    expect(firstStart).toBe(0);
    const lastStart = clamp(total - 1 - 2, 0, Math.max(0, total - 5));
    const lastEnd = Math.min(total, lastStart + 5);
    expect(lastStart).toBeLessThanOrEqual(total - 1);
    expect(total - 1).toBeLessThan(lastEnd);
  });
});
