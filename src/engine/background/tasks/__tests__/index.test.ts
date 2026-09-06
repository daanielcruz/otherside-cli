import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  addUsage,
  appendAssistantText,
  completeTask,
  get as getBackgroundTask,
  removeTask,
  setUsageSnapshot,
  startShellTask,
  startTask,
} from "../background.ts";
import {
  block,
  claimTask,
  clearAll,
  clearScope,
  create,
  list,
  MAIN_TASK_SCOPE,
  notifySubscribers,
  remove,
  reset,
  subscribe,
  updateTaskRecord,
} from "../index.ts";
import {
  getTaskSpillPath,
  isTaskOutputPath,
  renderTaskResultForMessage,
  resolveTaskLogPath,
  setTaskOutputSession,
  taskResultArchiveBanner,
  taskResultCharacterBudget,
} from "../output-files.ts";

// A task left running in the shared store gates unrelated suites
// (pressure reap skips while any agent task runs; the shared output
// poller stays armed while any shell task runs).
const startedTasks: string[] = [];
afterEach(() => {
  for (const id of startedTasks.splice(0)) removeTask(id);
});

describe("Task List Persistence", () => {
  let tempBaseDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "otherside-tasks-test-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(tempBaseDir, "config");
    clearAll();
  });

  afterEach(() => {
    clearAll();
    if (savedConfigDir === undefined) {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    } else {
      process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    }
    rmSync(tempBaseDir, { recursive: true, force: true });
  });

  test("create -> clearScope -> rehydrate-on-access -> list shows tasks", () => {
    const scope = "test-session-1";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });

    // Create a task
    const task = create({ subject: "First task", description: "This is a test task" }, scope);
    expect(task.id).toBe("1");
    expect(task.subject).toBe("First task");

    // Clear the scope from memory (simulating session close)
    clearScope(scope);

    // Assert it is no longer cached in memory (stores/hydratedScopes cleared)
    // When we call list(), it should lazy-hydrate from disk
    const tasks = list(scope);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe("1");
    expect(tasks[0]?.subject).toBe("First task");
    expect(tasks[0]?.description).toBe("This is a test task");
  });

  test("id continuity via highwatermark after clearScope", () => {
    const scope = "test-session-2";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });

    // Create 2 tasks
    const task1 = create({ subject: "Task 1", description: "desc1" }, scope);
    const task2 = create({ subject: "Task 2", description: "desc2" }, scope);
    expect(task1.id).toBe("1");
    expect(task2.id).toBe("2");

    // Remove task 2 (deleted tasks should not have their IDs reused)
    remove("2", scope);

    // Clear memory
    clearScope(scope);

    // Create task 3, it should continue from the highwatermark (2 + 1 = 3)
    const task3 = create({ subject: "Task 3", description: "desc3" }, scope);
    expect(task3.id).toBe("3");
  });

  test("update rewrites file", () => {
    const scope = "test-session-3";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });

    create({ subject: "Original", description: "desc" }, scope);
    const taskFile = join(process.env.OTHERSIDE_CONFIG_DIR!, "tasks", scope, "1");
    expect(existsSync(taskFile)).toBe(true);

    const originalContent = JSON.parse(readFileSync(taskFile, "utf8"));
    expect(originalContent.subject).toBe("Original");

    // Update task
    updateTaskRecord("1", { subject: "Updated" }, scope);

    const updatedContent = JSON.parse(readFileSync(taskFile, "utf8"));
    expect(updatedContent.subject).toBe("Updated");
  });

  test("delete removes file", () => {
    const scope = "test-session-4";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });

    create({ subject: "To be deleted", description: "desc" }, scope);
    const taskFile = join(process.env.OTHERSIDE_CONFIG_DIR!, "tasks", scope, "1");
    expect(existsSync(taskFile)).toBe(true);

    // Delete task
    remove("1", scope);
    expect(existsSync(taskFile)).toBe(false);
  });

  test("completed tasks persist in memory AND on disk with no expiry", async () => {
    const scope = "test-session-5";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });
    create({ subject: "done", description: "d" }, scope);
    create({ subject: "stays", description: "d" }, scope);
    updateTaskRecord("1", { status: "completed" }, scope);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(list(scope).map((t) => `${t.id}:${t.status}`)).toEqual(["1:completed", "2:pending"]);
    const dir = join(process.env.OTHERSIDE_CONFIG_DIR!, "tasks", scope);
    expect(existsSync(join(dir, "1"))).toBe(true);
    expect(existsSync(join(dir, "2"))).toBe(true);

    // Completed records also survive a process boundary (rehydration).
    clearScope(scope);
    expect(list(scope).map((t) => `${t.id}:${t.status}`)).toEqual(["1:completed", "2:pending"]);
  });

  test("reset removes every record but preserves the highwatermark", () => {
    const scope = "test-session-6";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });
    create({ subject: "a", description: "d" }, scope);
    create({ subject: "b", description: "d" }, scope);
    block("1", "2", scope);
    updateTaskRecord("1", { status: "completed" }, scope);
    updateTaskRecord("2", { status: "completed" }, scope);

    reset(scope);

    expect(list(scope)).toEqual([]);
    const dir = join(process.env.OTHERSIDE_CONFIG_DIR!, "tasks", scope);
    expect(existsSync(join(dir, "1"))).toBe(false);
    expect(existsSync(join(dir, "2"))).toBe(false);
    expect(existsSync(join(dir, ".highwatermark"))).toBe(true);

    // IDs never restart after a reset — the highwatermark carries continuity.
    const next = create({ subject: "new", description: "d" }, scope);
    expect(next.id).toBe("3");
  });

  test("reset ID continuity survives a process boundary", () => {
    const scope = "test-session-7";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });
    create({ subject: "a", description: "d" }, scope);
    updateTaskRecord("1", { status: "completed" }, scope);
    reset(scope);
    clearScope(scope);

    const next = create({ subject: "later", description: "d" }, scope);
    expect(next.id).toBe("2");
  });

  test("reset on an empty list is a no-op", () => {
    const scope = "test-session-8";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });
    reset(scope);
    expect(list(scope)).toEqual([]);
    const first = create({ subject: "first", description: "d" }, scope);
    expect(first.id).toBe("1");
  });

  test("unassign persists: write-through visible after rehydration", () => {
    const scope = "unassign-persist-test";
    setTaskOutputSession({ sessionId: scope, cwd: "/dummy/cwd" });

    const task = create({ subject: "task to unassign", description: "d" }, scope);
    expect(task.owner).toBeUndefined();

    // Claim it
    const claimRes = claimTask(task.id, "worker-a", scope);
    expect(claimRes.success).toBe(true);
    if (claimRes.success) {
      expect(claimRes.task.owner).toBe("worker-a");
    }

    // Clear scope and verify rehydration keeps the owner
    clearScope(scope);
    expect(list(scope)[0]?.owner).toBe("worker-a");

    // Unassign it
    const unassignRes = claimTask(task.id, "", scope);
    expect(unassignRes.success).toBe(true);
    if (unassignRes.success) {
      expect(unassignRes.task.owner).toBeUndefined();
    }

    // Clear scope and verify rehydration keeps it unassigned
    clearScope(scope);
    const rehydrated = list(scope)[0];
    expect(rehydrated?.owner).toBeUndefined();
  });

  test("block rejects missing endpoints without one-sided edges", () => {
    const scope = "dependency-endpoint-test";
    create({ subject: "existing", description: "d" }, scope);

    expect(block("1", "missing", scope)).toBe(false);
    expect(block("missing", "1", scope)).toBe(false);
    expect(list(scope)[0]?.blocks).toEqual([]);
    expect(list(scope)[0]?.blockedBy).toEqual([]);
  });
});

describe("Background Task Store token usage snapshotting", () => {
  test("correctly reconciles snapshots and turn-complete additions without double-counting", () => {
    const bgTask = startTask({
      parentToolCallId: "parent-tool-1",
      agentName: "TokenTestAgent",
    });
    startedTasks.push(bgTask.id);

    const taskId = bgTask.id;
    let task = getBackgroundTask(taskId);
    expect(task).toBeDefined();
    expect(task?.inputTokens).toBe(0);
    expect(task?.outputTokens).toBe(0);

    // 1. Send mid-turn snapshot during turn 1
    setUsageSnapshot(taskId, { inputTokens: 100, outputTokens: 50 });
    task = getBackgroundTask(taskId);
    expect(task?.inputTokens).toBe(100);
    expect(task?.outputTokens).toBe(50);

    // 2. Final usage for turn 1 (cumulative for turn 1 is 200)
    addUsage(taskId, { inputTokens: 100, outputTokens: 200 });
    task = getBackgroundTask(taskId);
    expect(task?.inputTokens).toBe(100);
    expect(task?.outputTokens).toBe(200);

    // 3. Send mid-turn snapshot during turn 2 (turn 2 generated 30 tokens so far)
    setUsageSnapshot(taskId, { inputTokens: 120, outputTokens: 30 });
    task = getBackgroundTask(taskId);
    expect(task?.inputTokens).toBe(120);
    expect(task?.outputTokens).toBe(230); // 200 (turn 1) + 30 (turn 2)

    // 4. Final usage for turn 2 (cumulative for turn 2 is 100 tokens)
    addUsage(taskId, { inputTokens: 120, outputTokens: 100 });
    task = getBackgroundTask(taskId);
    expect(task?.inputTokens).toBe(120);
    expect(task?.outputTokens).toBe(300); // 200 (turn 1) + 100 (turn 2)
  });

  test("counts cache tokens in the context input so a cache hit does not shrink the counter", () => {
    const bgTask = startTask({
      parentToolCallId: "call-cache",
      agentName: "general-purpose",
    });
    startedTasks.push(bgTask.id);
    const taskId = bgTask.id;

    // Cache miss: whole prompt sent uncached -> input_tokens carries the full 200k.
    setUsageSnapshot(taskId, { inputTokens: 200_000, outputTokens: 40, cacheReadInputTokens: 0 });
    expect(getBackgroundTask(taskId)?.inputTokens).toBe(200_000);

    // Cache hit next turn: only the 10k delta is uncached, the rest rides cache_read.
    // The context size is unchanged, so the counter must stay ~200k, not drop to 10k.
    addUsage(taskId, { inputTokens: 10_000, outputTokens: 50, cacheReadInputTokens: 190_000 });
    expect(getBackgroundTask(taskId)?.inputTokens).toBe(200_000);
  });
});

describe("Background task completion notifications (autoTurn / stoppedByUser)", () => {
  afterEach(() => {
    emitQueue._resetForTests();
  });

  function notificationFor(taskId: string) {
    return emitQueue
      .peek({ class: "deferred_output" })
      .find((item) => item.replayKey?.startsWith(`bg:${taskId}:`));
  }

  function summaryOf(item: ReturnType<typeof notificationFor>): string | undefined {
    return item?.payload.kind === "task_notification_xml" ? item.payload.summary : undefined;
  }

  test("a model-initiated stop (no userInitiated flag) is not attributed to the user, and still wakes an idle turn", () => {
    const task = startShellTask({
      shellId: "shell-model-stop",
      command: "sleep 100",
      parentToolCallId: "call-model-stop",
    });

    completeTask(task.id, { content: "Killed by parent agent", isError: false, killed: true });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    expect(item?.autoTurn).not.toBe(false);
    expect(summaryOf(item)).not.toContain("by the user");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("a user-initiated stop is attributed to the user in the summary, but still wakes an idle turn", () => {
    const task = startShellTask({
      shellId: "shell-user-stop",
      command: "sleep 100",
      parentToolCallId: "call-user-stop",
    });

    completeTask(task.id, {
      content: "Killed by parent agent",
      isError: false,
      killed: true,
      userInitiated: true,
    });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    expect(item?.autoTurn).not.toBe(false);
    // A stopped background command reads "was stopped" with no attribution
    // suffix; only agent/workflow kills carry "by user".
    expect(summaryOf(item)).toContain("was stopped");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  function resultOf(item: ReturnType<typeof notificationFor>): string | undefined {
    if (item?.payload.kind !== "task_notification_xml") return undefined;
    return /<result>([\s\S]*?)<\/result>/.exec(item.payload.text)?.[1];
  }

  test("a killed agent still delivers the answer it had streamed before stopping", () => {
    const task = startTask({
      parentToolCallId: "call-killed-partial",
      agentName: "researcher",
      description: "survey the codebase",
      isBackgrounded: true,
    });
    appendAssistantText(task.id, "Found three call sites so far");

    completeTask(task.id, { content: "Killed by user", isError: false, killed: true });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    // The cancellation reason belongs to the summary; <result> carries output.
    expect(resultOf(item)).toBe("Found three call sites so far");
    expect(summaryOf(item)).toContain("stopped");
  });

  test("a killed agent that produced nothing ships no result element", () => {
    const task = startTask({
      parentToolCallId: "call-killed-empty",
      agentName: "researcher",
      description: "survey the codebase",
      isBackgrounded: true,
    });

    completeTask(task.id, { content: "Killed by user", isError: false, killed: true });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    expect(resultOf(item)).toBeUndefined();
  });

  test("a nested agent task (ownerId set) notifies only its owner, never the main projection", () => {
    const release = emitQueue.registerOwner("fork_parent_1");
    const task = startTask({
      parentToolCallId: "call-nested-child",
      agentName: "Generalist",
      isBackgrounded: true,
      ownerId: "fork_parent_1",
    });

    completeTask(task.id, { content: "child failed", isError: true });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    expect(item?.ownerId).toBe("fork_parent_1");
    // inventory-only: the owner's loop drains it via takeForOwner; the main
    // conversation must never see it
    expect(item?.target).toBe("inventory");
    const owned = emitQueue.takeForOwner("fork_parent_1");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.payload.kind).toBe("task_notification_xml");
    if (owned[0]?.payload.kind === "task_notification_xml") {
      expect(owned[0].payload.text).toContain("<error>child failed</error>");
    }
    release();
  });

  test("a main-spawned agent task (no ownerId) targets the main conversation", () => {
    const task = startTask({
      parentToolCallId: "call-main-child",
      agentName: "Generalist",
      isBackgrounded: true,
    });

    completeTask(task.id, { content: "done", isError: false });

    const item = notificationFor(task.id);
    expect(item).toBeDefined();
    expect(item?.ownerId).toBeUndefined();
    expect(item?.target).toBe("both");
  });
});

describe("Session rebind invariants", () => {
  let tempBaseDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "otherside-tasks-rebind-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(tempBaseDir, "config");
    clearAll();
  });

  afterEach(() => {
    clearAll();
    if (savedConfigDir === undefined) {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    } else {
      process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    }
    rmSync(tempBaseDir, { recursive: true, force: true });
  });

  test("subscriber survives clearScope, and an access inside the rebind window cannot pin the old session's records", () => {
    setTaskOutputSession({ sessionId: "rebind-old", cwd: tempBaseDir });
    const done = create({ subject: "old done", description: "old" });
    updateTaskRecord(done.id, { status: "completed" });

    const snapshots: string[][] = [];
    const unsubscribe = subscribe(() =>
      snapshots.push(list().map((t) => `${t.subject}:${t.status}`)),
    );

    clearScope(MAIN_TASK_SCOPE);
    // A notify landing before the rebind (e.g. a future session finalizer)
    // hydrates the OLD directory — correct at that instant...
    notifySubscribers();
    expect(snapshots.at(-1)).toEqual(["old done:completed"]);

    // ...and the rebind must invalidate that hydration on the next access.
    setTaskOutputSession({ sessionId: "rebind-new", cwd: tempBaseDir });
    notifySubscribers();
    expect(snapshots.at(-1)).toEqual([]);
    expect(list()).toEqual([]);

    // The always-mounted subscriber still observes the new session's writes.
    create({ subject: "new task", description: "new" });
    expect(snapshots.at(-1)).toEqual(["new task:pending"]);
    unsubscribe();
  });

  test("startShellTask keeps an explicit start time (including 0) and defaults to now", () => {
    const explicit = startShellTask({
      shellId: "shell-pinned-start",
      command: "sleep 1",
      parentToolCallId: "call-start-a",
      startedAt: 123_456,
    });
    startedTasks.push(explicit.id);
    expect(explicit.startedAt).toBe(123_456);

    const zero = startShellTask({
      shellId: "shell-zero-start",
      command: "sleep 1",
      parentToolCallId: "call-start-b",
      startedAt: 0,
    });
    startedTasks.push(zero.id);
    expect(zero.startedAt).toBe(0);

    const before = Date.now();
    const fallback = startShellTask({
      shellId: "shell-default-start",
      command: "sleep 1",
      parentToolCallId: "call-start-c",
    });
    startedTasks.push(fallback.id);
    expect(fallback.startedAt).toBeGreaterThanOrEqual(before);
  });

  test("a task's output and spill paths stay pinned across a session rebind", () => {
    setTaskOutputSession({ sessionId: "pin-old", cwd: tempBaseDir });
    const outputBefore = resolveTaskLogPath("shell-pin-probe");
    const spillBefore = getTaskSpillPath({ taskId: "shell-pin-probe", stream: "stdout" });

    setTaskOutputSession({ sessionId: "pin-new", cwd: tempBaseDir });
    expect(resolveTaskLogPath("shell-pin-probe")).toBe(outputBefore);
    expect(getTaskSpillPath({ taskId: "shell-pin-probe", stream: "stdout" })).toBe(spillBefore);
    // The pre-rebind path stays recognized (Read allowlist/labels).
    expect(isTaskOutputPath(outputBefore)).toBe(true);

    // A task first seen after the rebind lands in the new session's dir.
    const fresh = resolveTaskLogPath("shell-post-rebind");
    expect(fresh).not.toBe(outputBefore);
    expect(fresh).toContain("pin-new");
  });
});

describe("task result message budget", () => {
  let savedResultLimit: string | undefined;

  beforeEach(() => {
    savedResultLimit = process.env.TASK_MAX_OUTPUT_LENGTH;
  });

  afterEach(() => {
    if (savedResultLimit === undefined) delete process.env.TASK_MAX_OUTPUT_LENGTH;
    else process.env.TASK_MAX_OUTPUT_LENGTH = savedResultLimit;
  });

  test("uses the default for unusable limits and caps large requests", () => {
    for (const setting of ["", "nope", "0", "-12"]) {
      process.env.TASK_MAX_OUTPUT_LENGTH = setting;
      expect(taskResultCharacterBudget()).toBe(32_000);
    }
    process.env.TASK_MAX_OUTPUT_LENGTH = "999999";
    expect(taskResultCharacterBudget()).toBe(160_000);
  });

  test("keeps exact-fit text and prefixes only the retained suffix after overflow", () => {
    setTaskOutputSession({ sessionId: "message-budget-test", cwd: "/dummy/cwd" });
    const taskKey = "message-budget-probe";
    const expectedBanner = taskResultArchiveBanner(taskKey);
    const characterBudget = expectedBanner.length + 5;
    process.env.TASK_MAX_OUTPUT_LENGTH = String(characterBudget);

    const boundaryText = "x".repeat(characterBudget);
    expect(renderTaskResultForMessage(boundaryText, taskKey)).toEqual({
      textForModel: boundaryText,
      trimmedForMessage: false,
    });

    const sourceText = `${boundaryText}omega`;
    expect(renderTaskResultForMessage(sourceText, taskKey)).toEqual({
      textForModel: `${expectedBanner}omega`,
      trimmedForMessage: true,
    });
  });
});
