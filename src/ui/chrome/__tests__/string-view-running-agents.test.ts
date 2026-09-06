import { afterAll, afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import chalk from "chalk";
import { clear as clearAgents, register as registerAgent } from "@/engine/agents/registry.ts";
import {
  clear as clearBackgroundTasks,
  completeTask,
  resetEmitThrottleForTests,
  setTaskParked,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  enrollWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { overlayStack, overlayStore } from "@/store/overlay-stack/index.ts";
import { setPromptMenuOpen } from "@/store/prompt/index.ts";
import { generatorActiveRef } from "@/store/turn-run/index.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import {
  panelRowAllocation,
  StringViewRunningAgents,
} from "@/ui/chrome/string-view-running-agents.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const originalColorLevel = chalk.level;
chalk.level = 3;

afterAll(() => {
  chalk.level = originalColorLevel;
});

function runningWorkflow(id: string, startedAt: number): void {
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
    startedAt,
    abortController: new AbortController(),
  } as WorkflowTaskLifecycle);
}

beforeEach(() => {
  overlayStore.setState(() => ({ openStack: [], pendingChain: [], slices: {} }));
});

afterEach(() => {
  clearBackgroundTasks();
  resetWorkflowTasksForTests();
  resetEmitThrottleForTests();
  clearAgents();
  setPromptMenuOpen(false);
  setSystemTime();
  generatorActiveRef.current = false;
  dispatch({ type: "view/setViewingAgent", id: null });
  dispatch({ type: "view/setPanelFocused", focused: false });
  dispatch({ type: "view/setPanelSelection", value: 0 });
  overlayStore.setState(() => ({ openStack: [], pendingChain: [], slices: {} }));
});

describe("StringViewRunningAgents", () => {
  it("caps both task namespaces while the main turn streams", () => {
    expect(panelRowAllocation(100, true, 20, 20)).toEqual({
      agentRows: 5,
      workflowRows: 5,
    });
  });

  it("keeps the fixed five-row agent window when the main turn is idle", () => {
    expect(panelRowAllocation(100, false, 20, 0).agentRows).toBe(5);
    expect(panelRowAllocation(100, false, 3, 0).agentRows).toBe(3);
  });

  it("budgets both workflow overflow markers in a sliding middle window", () => {
    for (let index = 0; index < 8; index += 1) {
      runningWorkflow(`workflow-${index}`, index);
    }
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const panel = new StringViewRunningAgents();
    panel.mount({
      requestRender: () => {},
      pushFocus: () => {},
      popFocus: () => {},
      terminalRows: () => 20,
    });
    panel.render(120);
    setSystemTime(new Date("2026-01-01T00:00:04.000Z"));
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 6 });

    const rows = panel.render(120).map(stripAnsi);

    expect(panelRowAllocation(20, false, 0, 8)).toEqual({ agentRows: 0, workflowRows: 6 });
    expect(rows.filter((row) => row.includes(`${Glyph.arrowUp} `))).toHaveLength(1);
    expect(rows.filter((row) => row.includes(`${Glyph.arrowDown} `))).toHaveLength(1);
    expect(rows).toHaveLength(9);
    panel.unmount();
  });

  it("renders nothing when no background agents are active", () => {
    expect(new StringViewRunningAgents().render(80)).toEqual([]);
  });

  it("subscribes to task changes and renders active agent bullet rows", () => {
    const panel = new StringViewRunningAgents();
    let renderRequests = 0;
    const ctx: StringViewContext = {
      requestRender: () => {
        renderRequests += 1;
      },
      pushFocus: () => {},
      popFocus: () => {},
    };

    panel.mount(ctx);
    expect(panel.render(80)).toEqual([]);

    startTask({
      parentToolCallId: "call_test_agent",
      agentName: "Generalist",
      description: "Inspect the renderer",
      isBackgrounded: true,
    });

    expect(renderRequests).toBe(1);
    const rows = panel.render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes(`${Glyph.bullet} main`))).toBe(true);
    expect(rows.some((row) => row.includes(`${Glyph.bulletHollow} Generalist`))).toBe(true);

    panel.unmount();
    resetEmitThrottleForTests();
    clearBackgroundTasks();
    expect(renderRequests).toBe(1);
  });

  it("leaves the rows to the command menu while it is open", () => {
    const panel = new StringViewRunningAgents();
    startTask({
      parentToolCallId: "call_menu_agent",
      agentName: "Generalist",
      description: "Inspect the renderer",
      isBackgrounded: true,
    });

    const visible = panel.render(80).map(stripAnsi);
    expect(visible.some((row) => row.includes(`${Glyph.bulletHollow} Generalist`))).toBe(true);

    setPromptMenuOpen(true);
    expect(panel.render(80)).toEqual([]);

    setPromptMenuOpen(false);
    expect(panel.render(80).map(stripAnsi)).toEqual(visible);
  });

  it("renders agent type in the suffix slot instead of the route model display name", () => {
    registerAgent({
      id: "general-purpose",
      name: "Generalist",
      description: "test agent",
      body: "",
      tools: null,
      disallowedTools: null,
      model: {},
      background: false,
      scope: "builtin",
    });

    startTask({
      parentToolCallId: "call_type_suffix",
      agentName: "review-auth",
      agentId: "general-purpose",
      description: "Inspect the renderer",
      provider: "anthropic",
      model: "secret-model-id-must-not-render",
      isBackgrounded: true,
    });

    const rows = new StringViewRunningAgents().render(120).map(stripAnsi);
    const agentRow = rows.find((row) => row.includes(`${Glyph.bulletHollow} Generalist`));
    expect(agentRow).toBeDefined();
    expect(agentRow).not.toContain("review-auth");
    expect(agentRow).toContain("Inspect the renderer");
    expect(agentRow).not.toContain("secret-model-id-must-not-render");
  });

  it("freezes a parked agent's elapsed at the park moment until it wakes", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const task = startTask({
      parentToolCallId: "call_parked",
      agentName: "worker",
      description: "Waits on a child",
      isBackgrounded: true,
    });

    setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    setTaskParked(task.id, true);
    setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const parkedRow = new StringViewRunningAgents()
      .render(120)
      .map(stripAnsi)
      .find((row) => row.includes("Waits on a child"));
    expect(parkedRow).toContain("5s");
    expect(parkedRow).not.toContain("1m");

    setTaskParked(task.id, false);
    const wokenRow = new StringViewRunningAgents()
      .render(120)
      .map(stripAnsi)
      .find((row) => row.includes("Waits on a child"));
    expect(wokenRow).toContain("1m");
  });

  it("keeps the given name when the task carries no resolvable type", () => {
    registerAgent({
      id: "explore",
      name: "Fast explorer",
      description: "test agent",
      body: "",
      tools: null,
      disallowedTools: null,
      model: {},
      background: false,
      scope: "builtin",
    });

    startTask({
      parentToolCallId: "call_same_name",
      agentName: "Fast explorer",
      description: "Find the theme file",
      isBackgrounded: true,
    });

    const rows = new StringViewRunningAgents().render(120).map(stripAnsi);
    const agentRow = rows.find((row) => row.includes(`${Glyph.bulletHollow} Fast explorer`));
    expect(agentRow).toBeDefined();
    expect(agentRow).toContain("Find the theme file");
  });

  it("moves the filled bullet onto the row whose document is open", () => {
    const task = startTask({
      parentToolCallId: "call_viewed",
      agentName: "reviewer",
      description: "audit",
      isBackgrounded: true,
    });

    const onMain = new StringViewRunningAgents().render(120).map(stripAnsi);
    expect(onMain[0]).toContain(`${Glyph.bullet} main`);
    expect(onMain[1]).toContain(`${Glyph.bulletHollow} reviewer`);

    dispatch({ type: "view/setViewingAgent", id: task.id });
    const onAgent = new StringViewRunningAgents().render(120).map(stripAnsi);
    expect(onAgent[0]).toContain(`${Glyph.bulletHollow} main`);
    expect(onAgent[1]).toContain(`${Glyph.bullet} reviewer`);
    dispatch({ type: "view/setViewingAgent", id: null });
  });

  // The agent finishes on its own schedule, which may be while its document is being
  // read. The list leaving at that moment would take the only way back with it.
  it("keeps the way back to main after the agent being read has finished", () => {
    const task = startTask({
      parentToolCallId: "call_finished",
      agentName: "reviewer",
      agentId: "general-purpose",
      description: "audit",
      isBackgrounded: true,
    });
    dispatch({ type: "view/setViewingAgent", id: task.id });
    completeTask(task.id, { content: "done", isError: false });

    const rows = new StringViewRunningAgents().render(120).map(stripAnsi);
    expect(rows.some((row) => row.includes(`${Glyph.bulletHollow} main`))).toBe(true);
    dispatch({ type: "view/setViewingAgent", id: null });
  });

  it("keeps a finished row listed until the store evicts it", () => {
    const task = startTask({
      parentToolCallId: "call_left",
      agentName: "reviewer",
      agentId: "general-purpose",
      description: "settled audit",
      isBackgrounded: true,
    });
    completeTask(task.id, { content: "done", isError: false });

    // The settled run is still the way back to its document; only eviction
    // (or the close gesture) takes the row with it.
    const rows = new StringViewRunningAgents().render(120).map(stripAnsi);
    expect(rows.some((row) => row.includes("settled audit"))).toBe(true);

    clearBackgroundTasks();
    expect(new StringViewRunningAgents().render(120)).toEqual([]);
  });

  // Colour law: unselected+unviewed rows are dim, the selection lifts the dim
  // without adding weight, and only the viewed document renders bold.
  it("dims rows the reader is not on and lifts the dim on the selected row", () => {
    startTask({
      parentToolCallId: "call_colour_law",
      agentName: "reviewer",
      agentId: "general-purpose",
      description: "audit",
      isBackgrounded: true,
    });

    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";

    // Viewing main, panel not focused: main is bold (viewed), the agent row is dim.
    const idle = new StringViewRunningAgents().render(120);
    expect(idle[0]).toContain(BOLD);
    expect(idle[0]).not.toContain(DIM);
    expect(idle[1]).toContain(DIM);
    expect(idle[1]).not.toContain(BOLD);

    // Cursor on the agent row: its dim lifts, no bold appears, and the pointer
    // sits in the row's left lane without repainting it a colour of its own.
    // The key hint lives on the status bar's mode row, never in the strip.
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 1 });
    const hovered = new StringViewRunningAgents().render(120);
    expect(hovered.some((row) => stripAnsi(row).includes("Enter to view"))).toBe(false);
    expect(hovered[1]).not.toContain(DIM);
    expect(hovered[1]).not.toContain(BOLD);
    expect(stripAnsi(hovered[1]!).startsWith(Glyph.chevron)).toBe(true);
    expect(hovered[1]).not.toContain("\x1b[38;2;136;136;136m");

    dispatch({ type: "view/setPanelFocused", focused: false });
    dispatch({ type: "view/setPanelSelection", value: 0 });
  });

  // Reserve-and-fill: a shrink pads the strip to its granted height and only
  // releases the reserve after the hold, so height cannot ratchet the shell.
  it("holds its height with blank fill when rows leave, then releases after the hold", () => {
    const first = startTask({
      parentToolCallId: "call_reserve_a",
      agentName: "one",
      description: "left early",
      isBackgrounded: true,
    });
    startTask({
      parentToolCallId: "call_reserve_b",
      agentName: "two",
      description: "still running",
      isBackgrounded: true,
    });

    const panel = new StringViewRunningAgents();
    const tall = panel.render(120);
    completeTask(first.id, { content: "done", isError: false });

    const padded = panel.render(120);
    expect(padded.length).toBe(tall.length);
    expect(padded.at(-1)).toBe("");
  });

  it("keeps the busy row cap until the main turn has been idle for the hold", () => {
    for (let index = 0; index < 8; index += 1) {
      startTask({
        parentToolCallId: `call_regime_${index}`,
        agentName: `agent-${index}`,
        description: "work",
        isBackgrounded: true,
      });
    }
    // Idle just now: the expansive budget must NOT engage yet — the busy cap
    // (5 rows + main + overflow + trailing blank) holds through the flicker.
    generatorActiveRef.current = false;
    const rows = new StringViewRunningAgents().render(120).map(stripAnsi);
    const agentRows = rows.filter((row) => row.includes("work")).length;
    expect(agentRows).toBe(5);
    expect(rows.some((row) => row.includes("more"))).toBe(true);
  });

  // The agent window is edge-anchored on the cursor: rows past the budget are
  // reachable because the frame slides when the selection leaves it.
  it("slides the agent window to keep the cursor's row on screen", () => {
    for (let index = 0; index < 8; index += 1) {
      startTask({
        parentToolCallId: `call_slide_${index}`,
        agentName: `agent-${index}`,
        description: "work",
        isBackgrounded: true,
      });
    }
    generatorActiveRef.current = false;
    const panel = new StringViewRunningAgents();
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 8 });

    const rows = panel.render(120).map(stripAnsi);
    expect(rows.some((row) => row.includes("agent-7"))).toBe(true);
    expect(rows.some((row) => row.includes("agent-0"))).toBe(false);
    const mainRow = rows.find((row) => row.includes("main"));
    expect(mainRow).toContain("↑ 3 more");

    dispatch({ type: "view/setPanelFocused", focused: false });
    dispatch({ type: "view/setPanelSelection", value: 0 });
  });

  it("resets agent and workflow window starts when remounted", () => {
    for (let index = 0; index < 8; index += 1) {
      startTask({
        parentToolCallId: `call_remount_${index}`,
        agentName: `remount-agent-${index}`,
        description: "work",
        isBackgrounded: true,
      });
      runningWorkflow(`remount-workflow-${index}`, index);
    }
    generatorActiveRef.current = true;
    const panel = new StringViewRunningAgents();
    const ctx: StringViewContext = {
      requestRender: () => {},
      pushFocus: () => {},
      popFocus: () => {},
    };
    panel.mount(ctx);
    dispatch({ type: "view/setPanelFocused", focused: true });
    dispatch({ type: "view/setPanelSelection", value: 8 });
    expect(
      panel
        .render(120)
        .map(stripAnsi)
        .some((row) => row.includes("remount-agent-7")),
    ).toBe(true);
    dispatch({ type: "view/setPanelSelection", value: 16 });
    expect(
      panel
        .render(120)
        .map(stripAnsi)
        .some((row) => row.includes("remount-workflow-0")),
    ).toBe(true);

    panel.unmount();
    panel.mount(ctx);
    dispatch({ type: "view/setPanelFocused", focused: false });
    const remounted = panel.render(120).map(stripAnsi);

    expect(remounted.some((row) => row.includes("remount-agent-0"))).toBe(true);
    expect(remounted.some((row) => row.includes("remount-agent-7"))).toBe(false);
    expect(remounted.some((row) => row.includes("remount-workflow-7"))).toBe(true);
    expect(remounted.some((row) => row.includes("remount-workflow-0"))).toBe(false);
    panel.unmount();
  });

  // Without an open document only roots render; each carries its whole hidden
  // subtree as a (+N) badge.
  it("collapses nested children into the root's badge until a document opens", () => {
    const parent = startTask({
      parentToolCallId: "call_tree_parent",
      agentName: "parent",
      description: "level one",
      isBackgrounded: true,
    });
    const child = startTask({
      parentToolCallId: "call_tree_child",
      parentTaskId: parent.id,
      agentName: "child",
      description: "level two",
      isBackgrounded: true,
    });
    startTask({
      parentToolCallId: "call_tree_grandchild",
      parentTaskId: child.id,
      agentName: "grandchild",
      description: "level three",
      isBackgrounded: true,
    });

    const panel = new StringViewRunningAgents();
    const collapsed = panel.render(120).map(stripAnsi);
    expect(collapsed.some((row) => row.includes("parent") && row.includes("(+2)"))).toBe(true);
    expect(collapsed.some((row) => row.includes("level two"))).toBe(false);

    // Opening the parent's document unfolds its children; the grandchild stays
    // behind the child's own badge until the child itself is viewed.
    dispatch({ type: "view/setViewingAgent", id: parent.id });
    const unfolded = panel.render(120).map(stripAnsi);
    expect(unfolded.some((row) => row.includes("└") && row.includes("level two"))).toBe(true);
    expect(unfolded.some((row) => row.includes("level two") && row.includes("(+1)"))).toBe(true);
    expect(unfolded.some((row) => row.includes("level three"))).toBe(false);

    // Viewing the child unfolds the grandchild under it.
    dispatch({ type: "view/setViewingAgent", id: child.id });
    const deep = panel.render(120).map(stripAnsi);
    expect(deep.some((row) => row.includes("level three"))).toBe(true);

    dispatch({ type: "view/setViewingAgent", id: null });
  });

  // A nested row whose parent scrolled above the fold renders the continuation
  // gutter (├), never the closing └ — the branch reads as carried over.
  it("marks a nested row as a continuation when its parent scrolls off", () => {
    const parent = startTask({
      parentToolCallId: "call_fold_parent",
      agentName: "fold-parent",
      description: "root",
      isBackgrounded: true,
    });
    for (let index = 0; index < 6; index += 1) {
      startTask({
        parentToolCallId: `call_fold_child_${index}`,
        parentTaskId: parent.id,
        agentName: `fold-child-${index}`,
        description: `branch ${index}`,
        isBackgrounded: true,
      });
    }
    generatorActiveRef.current = false;
    const panel = new StringViewRunningAgents();
    dispatch({ type: "view/setViewingAgent", id: parent.id });
    dispatch({ type: "view/setPanelFocused", focused: true });
    // Cursor on the last child: the parent scrolls above the 5-row window.
    dispatch({ type: "view/setPanelSelection", value: 7 });

    const rows = panel.render(120).map(stripAnsi);
    expect(rows.some((row) => row.includes("fold-parent"))).toBe(false);
    const lastChildRow = rows.find((row) => row.includes("fold-child-5"));
    expect(lastChildRow).toContain("├");
    expect(lastChildRow).not.toContain("└");

    dispatch({ type: "view/setViewingAgent", id: null });
    dispatch({ type: "view/setPanelFocused", focused: false });
    dispatch({ type: "view/setPanelSelection", value: 0 });
  });

  // The owner's fan-out shape: one root, five level-2 children, one grandchild
  // each. With a document open on the first child, every visible level-2 row
  // keeps its tree gutter — including rows past the window cut, in every
  // position the sliding window can take.
  it("keeps sibling gutters on every windowed row of an unfolded subtree", () => {
    const root = startTask({
      parentToolCallId: "call_fan_root",
      agentName: "fan-root",
      description: "fan-out test",
      isBackgrounded: true,
    });
    const children: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const child = startTask({
        parentToolCallId: `call_fan_child_${index}`,
        parentTaskId: root.id,
        agentName: `fan-child-${index}`,
        description: `level two ${index}`,
        isBackgrounded: true,
      });
      children.push(child.id);
      startTask({
        parentToolCallId: `call_fan_grandchild_${index}`,
        parentTaskId: child.id,
        agentName: `fan-grandchild-${index}`,
        description: `level three ${index}`,
        isBackgrounded: true,
      });
    }

    generatorActiveRef.current = true;
    const panel = new StringViewRunningAgents();
    panel.mount({
      requestRender: () => {},
      pushFocus: () => {},
      popFocus: () => {},
      terminalRows: () => 40,
    });
    dispatch({ type: "view/setViewingAgent", id: children[0]! });
    dispatch({ type: "view/setPanelFocused", focused: true });

    // Walk the cursor across every row so the window slides through the whole
    // list; at each stop, every level-2 row on screen must carry its gutter.
    for (let selection = 1; selection <= 7; selection += 1) {
      dispatch({ type: "view/setPanelSelection", value: selection });
      const rows = panel.render(120).map(stripAnsi);
      for (const row of rows) {
        if (!row.includes("level two")) continue;
        expect(row).toMatch(/[├└] /);
      }
      // Sibling rows with hidden grandchildren keep their badges too.
      for (const row of rows) {
        if (/level two [1-4]/.test(row)) expect(row).toContain("(+1)");
      }
    }
    panel.unmount();
  });

  // While an overlay is open, background emits must not change the strip's
  // frame: the last rows freeze until the overlay closes.
  it("freezes its frame under an open overlay and thaws when it closes", () => {
    startTask({
      parentToolCallId: "call_freeze_a",
      agentName: "frozen",
      description: "before overlay",
      isBackgrounded: true,
    });
    const panel = new StringViewRunningAgents();
    const before = panel.render(120);

    overlayStack.open("help");
    startTask({
      parentToolCallId: "call_freeze_b",
      agentName: "hidden",
      description: "arrived under the overlay",
      isBackgrounded: true,
    });
    expect(panel.render(120)).toEqual(before);

    overlayStack.closeTop();
    const after = panel.render(120).map(stripAnsi);
    expect(after.some((row) => row.includes("arrived under the overlay"))).toBe(true);
  });
});
