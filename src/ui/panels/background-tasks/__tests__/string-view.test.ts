import { describe, expect, it } from "bun:test";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { createBackgroundTasksPanel } from "@/ui/panels/background-tasks/string-view.ts";

const ctx: StringViewContext = {
  requestRender: () => {},
  pushFocus: () => {},
  popFocus: () => {},
};

function shellTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "shell_detail_test",
    kind: "shell",
    parentToolCallId: "call_shell_detail",
    agentName: "shell",
    command:
      'while true; do if [ -f /tmp/placeholder-flag ] && [ "$(cat /tmp/placeholder-flag)" = "1" ]; then echo DONE; break; fi; sleep 300; done',
    startedAt: Date.now() - 60_000,
    status: "running",
    isBackgrounded: true,
    runGeneration: 0,
    runToken: "run_token_test",
    lifecycleMode: "task",
    terminalNotification: "toolResult",
    actions: [],
    assistantText: "",
    shellOutput: "",
    ...overrides,
  } as BackgroundTask;
}

function agentTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: `agent_${String(overrides.description ?? "task")}`,
    kind: "agent",
    parentToolCallId: "call_agent_test",
    agentName: "Generalist",
    startedAt: Date.now() - 30_000,
    status: "running",
    isBackgrounded: true,
    runGeneration: 0,
    runToken: "run_token_test",
    lifecycleMode: "task",
    terminalNotification: "toolResult",
    actions: [],
    assistantText: "",
    shellOutput: "",
    ...overrides,
  } as BackgroundTask;
}

function detailRows(task: BackgroundTask, width: number): string[] {
  const panel = createBackgroundTasksPanel(() => {}, { tasks: [task] });
  panel.mount?.(ctx);
  const rows = panel.render(width);
  panel.unmount?.();
  return rows;
}

function listRows(tasks: BackgroundTask[], width = 100, downs = 0): string[] {
  const panel = createBackgroundTasksPanel(() => {}, { tasks });
  panel.mount?.(ctx);
  for (let i = 0; i < downs; i++) {
    panel.handleKey?.({ name: "down" } as Parameters<NonNullable<typeof panel.handleKey>>[0]);
  }
  const rows = panel.render(width);
  panel.unmount?.();
  return rows.map(stripAnsi);
}

describe("background list layout", () => {
  const shell = () => shellTask({ id: "shell_1", command: 'sleep 60 && echo "shell done"' });
  const agentA = () =>
    agentTask({ id: "agent_a", description: "Sleep 60s agent A", startedAt: Date.now() - 40_000 });
  const agentB = () =>
    agentTask({ id: "agent_b", description: "Sleep 60s agent B", startedAt: Date.now() - 20_000 });

  it("renders the title, per-type counts, and typed sections", () => {
    const flat = listRows([shell(), agentA(), agentB()]);
    const joined = flat.join("\n");
    expect(joined).toContain("Background");
    expect(joined).not.toContain("Background tasks");
    expect(joined).toContain("1 active shell · 2 active agents");
    expect(joined).toContain("Shells (1)");
    expect(joined).toContain("Local agents (2)");
  });

  it("lists shells before agents and newer agents first", () => {
    const flat = listRows([agentA(), agentB(), shell()]);
    const shellAt = flat.findIndex((row) => row.includes("shell done"));
    const bAt = flat.findIndex((row) => row.includes("agent B"));
    const aAt = flat.findIndex((row) => row.includes("agent A"));
    expect(shellAt).toBeGreaterThan(-1);
    expect(shellAt).toBeLessThan(bAt);
    expect(bAt).toBeLessThan(aAt);
  });

  it("keeps rows lean: raw command plus status, no elapsed or tokens", () => {
    const flat = listRows([shell(), agentA(), agentB()]);
    const shellRow = flat.find((row) => row.includes("shell done"));
    expect(shellRow).toContain('sleep 60 && echo "shell done" (running)');
    expect(flat.join("\n")).not.toContain("tokens");
    expect(flat.join("\n")).not.toContain("· shell");
  });

  it("omits section headers when only one kind is present", () => {
    const joined = listRows([agentA(), agentB()]).join("\n");
    expect(joined).toContain("2 active agents");
    expect(joined).not.toContain("Local agents (2)");
    expect(joined).not.toContain("Shells");
  });

  it("shows stop-all only with an agent selected, and closes on Esc alone", () => {
    const shellSelected = listRows([shell(), agentA(), agentB()]).join("\n");
    expect(shellSelected).not.toContain("stop all");
    expect(shellSelected).toContain("Esc to close");
    expect(shellSelected).not.toContain("←/Esc");
    const agentSelected = listRows([shell(), agentA(), agentB()], 100, 1).join("\n");
    expect(agentSelected).toContain("ctrl+x ctrl+k to stop all agents");
  });

  it("uses singular forms for single tasks", () => {
    const joined = listRows([shell(), agentA()]).join("\n");
    expect(joined).toContain("1 active shell · 1 active agent");
  });
});

// Every emitted row must fit the panel width. An overlong row breaks physically
// in the terminal and desynchronizes the writer's row accounting — the ghost
// "Runtime:" duplicate and the label-less command tail came from exactly this.
describe("shell detail row width", () => {
  it("wraps the command inside the panel width at a narrow terminal", () => {
    const rows = detailRows(shellTask(), 60);
    const flat = rows.map(stripAnsi);
    expect(flat.some((row) => row.includes("Command:"))).toBe(true);
    expect(flat.join("\n")).toContain("sleep 300");
    for (const row of flat) {
      expect(stringWidth(row)).toBeLessThanOrEqual(60);
    }
  });

  it("clips shell output lines by cells, not characters", () => {
    const wide = "日本語の広い文字が続く行".repeat(12);
    const rows = detailRows(shellTask({ shellOutput: `${wide}\nplain tail line` }), 60);
    const flat = rows.map(stripAnsi);
    expect(flat.join("\n")).toContain("plain tail line");
    for (const row of flat) {
      expect(stringWidth(row)).toBeLessThanOrEqual(60);
    }
  });
});

describe("background list shared select keys", () => {
  const key = (name: string | undefined, overrides: Record<string, unknown> = {}) =>
    ({ name, ctrl: false, meta: false, ...overrides }) as Parameters<
      NonNullable<ReturnType<typeof createBackgroundTasksPanel>["handleKey"]>
    >[0];

  const tasks = () => [
    shellTask({ id: "shell_1", command: "sleep 60" }),
    agentTask({ id: "agent_a", description: "agent A", startedAt: Date.now() - 40_000 }),
    agentTask({ id: "agent_b", description: "agent B", startedAt: Date.now() - 20_000 }),
  ];

  const openPanel = (): ReturnType<typeof createBackgroundTasksPanel> => {
    const panel = createBackgroundTasksPanel(() => {}, { tasks: tasks() });
    panel.mount?.(ctx);
    return panel;
  };

  /** The task row the cursor points at; the command bar carries the same chevron. */
  const selectedRow = (panel: ReturnType<typeof createBackgroundTasksPanel>): string => {
    const row = panel
      .render(100)
      .map(stripAnsi)
      .find((line) => line.trimStart().startsWith("❯") && line.includes("(running)"));
    return (row ?? "").replace("❯", "").trim();
  };

  it("steps with j/k and ctrl+n/ctrl+p", () => {
    const panel = openPanel();
    expect(selectedRow(panel)).toContain("sleep 60");

    panel.handleKey?.(key("j", { sequence: "j" }));
    expect(selectedRow(panel)).toContain("agent B");

    panel.handleKey?.(key("k", { sequence: "k" }));
    expect(selectedRow(panel)).toContain("sleep 60");

    panel.handleKey?.(key("n", { ctrl: true }));
    panel.handleKey?.(key("n", { ctrl: true }));
    expect(selectedRow(panel)).toContain("agent A");

    panel.handleKey?.(key("p", { ctrl: true }));
    expect(selectedRow(panel)).toContain("agent B");
    panel.unmount?.();
  });

  it("reaches the ends with home/end", () => {
    const panel = openPanel();
    panel.handleKey?.(key("end"));
    expect(selectedRow(panel)).toContain("agent A");

    panel.handleKey?.(key("home"));
    expect(selectedRow(panel)).toContain("sleep 60");
    panel.unmount?.();
  });

  it("opens the nth task's detail on its digit", () => {
    const panel = openPanel();
    panel.handleKey?.(key("number", { sequence: "2" }));
    const rows = panel.render(100).map(stripAnsi).join("\n");
    expect(rows).toContain("agent B");
    expect(rows).not.toContain("active shell");
    panel.unmount?.();
  });
});
