import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

// The task store persists every record under the config root, so this suite runs
// against a disposable one: the real root would leave test rows in the user's list.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "otherside-tasks-"));
const PREVIOUS_CONFIG_DIR = process.env.OTHERSIDE_CONFIG_DIR;
process.env.OTHERSIDE_CONFIG_DIR = CONFIG_DIR;

const {
  clear: clearTasks,
  create: createTask,
  updateTaskRecord,
} = await import("@/engine/background/tasks/index.ts");
const { removeTask, setForkId, startTask } = await import(
  "@/engine/background/tasks/background.ts"
);
const { dispatch } = await import("@/store/app-store/index.ts");
const { generatorActiveRef, turnStartedAtRef } = await import("@/store/turn-run/index.ts");
const { stripAnsi } = await import("@/terminal-runtime/text/presentation-sequences.js");
const { StringViewProgress } = await import("@/ui/chrome/string-view-progress.ts");

const originalColorLevel = chalk.level;

beforeEach(() => {
  chalk.level = 3;
  clearTasks();
  dispatch({ type: "view/setTasksExpanded", value: false });
  dispatch({ type: "view/setTurnVerb", verb: "Thinking" });
});

afterEach(() => {
  generatorActiveRef.current = false;
  turnStartedAtRef.current = null;
  clearTasks();
  dispatch({ type: "view/setTasksExpanded", value: false });
  dispatch({ type: "view/setTurnVerb", verb: "Thinking" });
  dispatch({ type: "view/setTurnTipIndex", index: 0 });
  chalk.level = originalColorLevel;
});

afterAll(() => {
  if (PREVIOUS_CONFIG_DIR === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = PREVIOUS_CONFIG_DIR;
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function startTurn(): void {
  generatorActiveRef.current = true;
  turnStartedAtRef.current = Date.now();
}

describe("the task list outside a turn", () => {
  it("stays hidden while the toggle is off", () => {
    createTask({ subject: "audit the emitter", description: "" });
    expect(new StringViewProgress().render(80)).toEqual([]);
  });

  it("renders the list when the toggle is on, with a blank on each side", () => {
    createTask({ subject: "audit the emitter", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[0]).toBe("");
    expect(rows.at(-1)).toBe("");
    expect(rows.some((row) => row.includes("audit the emitter"))).toBe(true);
  });

  /**
   * Standing on its own the list follows nothing that explains it, so it opens with a
   * heading and carries a plain indent. Without those its rows land at the gutter of
   * whatever block the transcript ended on and read as part of it.
   */
  it("opens with a heading counting what it holds", () => {
    const done = createTask({ subject: "audit the emitter", description: "" });
    const running = createTask({ subject: "park the caret", description: "" });
    createTask({ subject: "measure the churn", description: "" });
    updateTaskRecord(done.id, { status: "completed" });
    updateTaskRecord(running.id, { status: "in_progress" });
    dispatch({ type: "view/setTasksExpanded", value: true });

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[1]).toBe("  3 tasks (1 done, 1 in progress, 1 open)");
    expect(rows[2]?.startsWith("  ")).toBe(true);
    expect(rows[2]?.trimStart()).toContain("audit the emitter");
  });

  it("drops the in-progress term from the heading when none is running", () => {
    createTask({ subject: "audit the emitter", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[1]).toBe("  1 tasks (0 done, 1 open)");
  });

  it("hangs the list off the spinner's gutter during a turn, with no heading", () => {
    createTask({ subject: "audit the emitter", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes("tasks ("))).toBe(false);
    expect(rows.some((row) => row.includes("└") && row.includes("audit the emitter"))).toBe(true);
  });

  it("draws nothing with the toggle on but no tasks to show", () => {
    dispatch({ type: "view/setTasksExpanded", value: true });
    expect(new StringViewProgress().render(80)).toEqual([]);
  });

  it("keeps internal tasks out of the list", () => {
    createTask({ subject: "bookkeeping", description: "", metadata: { _internal: true } });
    dispatch({ type: "view/setTasksExpanded", value: true });
    expect(new StringViewProgress().render(80)).toEqual([]);
  });
});

describe("recency across viewed boards", () => {
  /**
   * Regression: with an agent's document open the widget observes that agent's
   * board; coming back to the main view it must not mistake the session's
   * long-finished tasks for fresh completions. The bug paraded old struck-through
   * rows at the head of the truncated list while every live row hid behind the
   * "+N in progress, N pending" counter.
   */
  it("keeps old completions from leading the list after viewing an agent", () => {
    // Enough finished rows to overflow the display cap, so the list truncates.
    for (let i = 1; i <= 12; i += 1) {
      const done = createTask({ subject: `finished chore ${i}`, description: "" });
      updateTaskRecord(done.id, { status: "completed" });
    }
    const live = createTask({ subject: "current live work", description: "" });
    updateTaskRecord(live.id, { status: "in_progress" });
    createTask({ subject: "queued follow-up", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });
    startTurn();

    const view = new StringViewProgress();
    // First sight of the main board: nothing counts as recent.
    view.render(80);

    // Open a background agent's document (its fork board is empty), then return.
    const agent = startTask({
      parentToolCallId: "call-progress-test",
      agentName: "sample-agent",
      isBackgrounded: true,
    });
    setForkId(agent.id, "fork_progress_test");
    dispatch({ type: "view/setViewingAgent", id: agent.id });
    try {
      view.render(80);
      dispatch({ type: "view/setViewingAgent", id: null });

      const rows = view.render(80).map(stripAnsi);
      const taskRows = rows.filter((row) => /[✔◼◻]/.test(row));
      expect(taskRows.length).toBeGreaterThan(0);
      expect(taskRows[0]).toContain("current live work");
      const summary = rows.find((row) => row.includes("… +"));
      expect(summary).toBeDefined();
      expect(summary).not.toContain("in progress");
    } finally {
      dispatch({ type: "view/setViewingAgent", id: null });
      removeTask(agent.id);
    }
  });
});

describe("the spinner verb", () => {
  it("speaks the in-progress task's activeForm", () => {
    const task = createTask({
      subject: "Audit the emitter",
      description: "",
      activeForm: "Auditing the emitter",
    });
    updateTaskRecord(task.id, { status: "in_progress" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[0]).toContain("Auditing the emitter");
  });

  it("falls back to the subject when the task carries no activeForm", () => {
    const task = createTask({ subject: "Audit the emitter", description: "" });
    updateTaskRecord(task.id, { status: "in_progress" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[0]).toContain("Audit the emitter");
  });

  it("keeps the turn's own verb when nothing is in progress", () => {
    createTask({ subject: "Audit the emitter", description: "" });
    dispatch({ type: "view/setTurnVerb", verb: "Pondering" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[0]).toContain("Pondering");
  });

  /**
   * Regression: a compaction started with a task still in progress rendered that
   * task's activeForm instead, which read as a normal request — no compact bar,
   * no feedback that the conversation was being compacted.
   */
  it("lets a running compaction outrank the in-progress task's activeForm", () => {
    const task = createTask({
      subject: "Audit the emitter",
      description: "",
      activeForm: "Auditing the emitter",
    });
    updateTaskRecord(task.id, { status: "in_progress" });
    dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows[1]).toContain("Compacting conversation");
    expect(rows[2]).toMatch(/\d+%$/);
    expect(rows.some((row) => row.includes("Auditing the emitter"))).toBe(false);
  });
});

describe("the collapsed detail row", () => {
  it("names the next pending task rather than a tip", () => {
    createTask({ subject: "Write the test", description: "" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes("Next: Write the test"))).toBe(true);
    expect(rows.some((row) => row.includes("Tip:"))).toBe(false);
  });

  it("skips a pending task whose blocker is still open", () => {
    const blocker = createTask({ subject: "Land the fix", description: "" });
    const blocked = createTask({ subject: "Ship the release", description: "" });
    createTask({ subject: "Write the test", description: "" });
    updateTaskRecord(blocked.id, { blockedBy: [blocker.id] });
    updateTaskRecord(blocker.id, { status: "in_progress" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes("Next: Write the test"))).toBe(true);
  });

  it("falls back to a tip when nothing is pending", () => {
    const done = createTask({ subject: "Write the test", description: "" });
    updateTaskRecord(done.id, { status: "completed" });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes("Next:"))).toBe(false);
  });

  it("opens the full list once the toggle is on", () => {
    createTask({ subject: "Write the test", description: "" });
    dispatch({ type: "view/setTasksExpanded", value: true });
    startTurn();

    const rows = new StringViewProgress().render(80).map(stripAnsi);
    expect(rows.some((row) => row.includes("Next:"))).toBe(false);
    expect(rows.some((row) => row.includes("Write the test"))).toBe(true);
  });
});
