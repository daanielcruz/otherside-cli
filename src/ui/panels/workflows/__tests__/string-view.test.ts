import { afterEach, describe, expect, it } from "bun:test";
import {
  enrollWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { createWorkflowsPanel } from "@/ui/panels/workflows/string-view.ts";

const WIDTH = 100;
const context = { requestRender: () => {}, pushFocus: () => {}, popFocus: () => {} };

afterEach(() => {
  resetWorkflowTasksForTests();
});

function workflow(id: string, overrides: Partial<WorkflowTaskLifecycle> = {}): void {
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
    startedAt: Date.now(),
    abortController: new AbortController(),
    ...overrides,
  } as WorkflowTaskLifecycle);
}

function key(name: string): KeyEventData {
  return { name } as KeyEventData;
}

function panelRows(panel: ReturnType<typeof createWorkflowsPanel>): string[] {
  return panel.render(WIDTH).map(stripAnsi);
}

describe("workflows panel list", () => {
  it("lists every enrolled workflow and says which is selected", () => {
    workflow("alpha");
    workflow("beta", { status: "completed" });
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    const rows = panelRows(panel).join("\n");
    expect(rows).toContain("alpha");
    expect(rows).toContain("beta");
    expect(rows).toContain("Dynamic workflows");
    panel.unmount?.();
  });

  it("moves the selection down and back without leaving the list", () => {
    workflow("alpha");
    workflow("beta", { status: "completed" });
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    panel.handleKey?.(key("down"));
    const afterDown = panelRows(panel).join("\n");
    panel.handleKey?.(key("up"));
    const afterUp = panelRows(panel).join("\n");

    expect(afterDown).toContain("Dynamic workflows");
    expect(afterUp).toContain("Dynamic workflows");
    expect(afterUp).not.toBe(afterDown);
    panel.unmount?.();
  });

  it("opens the selected workflow and Esc returns to the list", () => {
    workflow("alpha");
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    panel.handleKey?.(key("return"));
    const detail = panelRows(panel).join("\n");
    expect(detail).toContain("alpha");
    expect(detail).not.toContain("Dynamic workflows");

    panel.handleKey?.(key("escape"));
    expect(panelRows(panel).join("\n")).toContain("Dynamic workflows");
    panel.unmount?.();
  });

  it("says the list is empty rather than rendering a blank frame", () => {
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    const rows = panelRows(panel).join("\n");
    expect(rows).toMatch(/No dynamic workflows in this session\.|Loading dynamic workflow history/);
    expect(rows).toContain("Esc");
    panel.unmount?.();
  });
});

describe("workflows list shared select keys", () => {
  const listKey = (name: string, overrides: Partial<KeyEventData> = {}): KeyEventData =>
    ({ name, ctrl: false, meta: false, ...overrides }) as KeyEventData;

  /** The list row the cursor points at; the command bar carries the same chevron. */
  const selectedRow = (panel: ReturnType<typeof createWorkflowsPanel>): string => {
    const row = panelRows(panel).find(
      (line) => line.trimStart().startsWith("❯") && !line.includes("/workflows"),
    );
    return (row ?? "").replace("❯", "").trim();
  };

  it("steps with j/k and reaches the ends with home/end", () => {
    workflow("alpha");
    workflow("beta");
    workflow("gamma");
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    const first = selectedRow(panel);
    panel.handleKey?.(listKey("j", { sequence: "j" }));
    const second = selectedRow(panel);
    expect(second).not.toBe(first);

    panel.handleKey?.(listKey("k", { sequence: "k" }));
    expect(selectedRow(panel)).toBe(first);

    panel.handleKey?.(listKey("end"));
    const last = selectedRow(panel);
    expect(last).not.toBe(first);

    panel.handleKey?.(listKey("home"));
    expect(selectedRow(panel)).toBe(first);
    panel.unmount?.();
  });

  it("opens the nth run's detail on its digit", () => {
    workflow("alpha");
    workflow("beta");
    workflow("gamma");
    const panel = createWorkflowsPanel(() => {});
    panel.mount?.(context);

    panel.handleKey?.(listKey("end"));
    const lastRow = selectedRow(panel);
    panel.handleKey?.(listKey("home"));

    panel.handleKey?.(listKey("number", { sequence: "3" }));
    const detail = panelRows(panel).join("\n");
    expect(detail).not.toContain("Dynamic workflows");
    expect(lastRow.split(" ").some((word) => detail.includes(word))).toBe(true);
    panel.unmount?.();
  });
});
