import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAll, create, list } from "@/engine/background/tasks/index.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { TaskCreate, TaskGet, TaskList, TaskUpdate } from "../task.ts";

function callFor(input: Record<string, unknown>): ToolCall {
  return { id: "call-1", name: "TaskCreate", input } as ToolCall;
}

function ctxFor(agentId?: string): RequestContext {
  return {
    sessionId: "sess-scope-test",
    cwd: "/dummy/cwd",
    agentId,
    agentOwnerId: agentId,
  } as RequestContext;
}

async function claimInWorker(owner: string, scope: string): Promise<Record<string, unknown>> {
  const script = `
    import { claimTask } from "./src/engine/background/tasks/index.ts";
    const result = claimTask("1", process.env.CLAIM_OWNER, process.env.CLAIM_SCOPE);
    console.log(JSON.stringify(result));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, CLAIM_OWNER: owner, CLAIM_SCOPE: scope },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

describe("task tools work the list of the thread they run in", () => {
  let tempBaseDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "otherside-task-scope-test-"));
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

  // A workflow worker plans in its own list — the one the footer shows while its
  // document is open and the one its teardown drops. Writing into the session's list
  // would leave the worker's private planning behind in the list the user works from.
  test("a worker's task is its own and never reaches the session list", async () => {
    const workerCtx = ctxFor("fork_worker_1");
    await TaskCreate.run(callFor({ subject: "worker task", description: "d" }), workerCtx);

    expect(list()).toHaveLength(0);
    expect(list("fork_worker_1").map((task) => task.subject)).toEqual(["worker task"]);
    const mainView = await TaskList.run(callFor({}), ctxFor());
    expect(String(mainView.content)).toBe("No tasks found");
  });

  test("a worker reads and writes its own list, not the session's", async () => {
    const mainCtx = ctxFor();
    const workerCtx = ctxFor("fork_worker_2");
    await TaskCreate.run(callFor({ subject: "session task", description: "d" }), mainCtx);

    expect(String((await TaskList.run(callFor({}), workerCtx)).content)).toBe("No tasks found");
    expect(String((await TaskGet.run(callFor({ taskId: "1" }), workerCtx)).content)).toBe(
      "Task not found",
    );
    const update = await TaskUpdate.run(callFor({ taskId: "1", status: "completed" }), workerCtx);
    expect(String(update.content)).toBe("Task not found");
    expect(list()[0]?.status).toBe("pending");

    await TaskCreate.run(callFor({ subject: "worker task", description: "d" }), workerCtx);
    expect(String((await TaskGet.run(callFor({ taskId: "1" }), workerCtx)).content)).toContain(
      "Task #1: worker task",
    );
    expect(list().map((task) => task.subject)).toEqual(["session task"]);
  });

  test("the session keeps reading and writing its own list", async () => {
    const mainCtx = ctxFor();
    await TaskCreate.run(callFor({ subject: "session task", description: "d" }), mainCtx);

    const listed = await TaskList.run(callFor({}), mainCtx);
    const got = await TaskGet.run(callFor({ taskId: "1" }), mainCtx);
    const updated = await TaskUpdate.run(callFor({ taskId: "1", status: "in_progress" }), mainCtx);

    expect(String(listed.content)).toContain("session task");
    expect(String(got.content)).toContain("Task #1: session task");
    expect(String(updated.content)).toBe("Updated task #1 status");
    expect(list()[0]?.status).toBe("in_progress");
  });

  test("TaskList hides internal tasks and reports empty when only internal remain", async () => {
    const mainCtx = ctxFor();
    await TaskCreate.run(
      callFor({ subject: "hidden", description: "d", metadata: { _internal: true } }),
      mainCtx,
    );

    const onlyInternal = await TaskList.run(callFor({}), mainCtx);
    expect(String(onlyInternal.content)).toBe("No tasks found");

    await TaskCreate.run(callFor({ subject: "visible", description: "d" }), mainCtx);
    const listed = await TaskList.run(callFor({}), mainCtx);
    expect(String(listed.content)).toBe("#2 [pending] visible");
  });

  test("TaskUpdate directly reassigns owner and applies other requested fields", async () => {
    const mainCtx = ctxFor();
    await TaskCreate.run(callFor({ subject: "assigned", description: "d" }), mainCtx);
    await TaskUpdate.run(callFor({ taskId: "1", owner: "worker-a" }), mainCtx);

    const result = await TaskUpdate.run(
      callFor({ taskId: "1", owner: "worker-b", status: "in_progress" }),
      mainCtx,
    );

    expect(String(result.content)).toBe("Updated task #1 owner, status");
    expect(list()[0]?.owner).toBe("worker-b");
    expect(list()[0]?.status).toBe("in_progress");
  });

  test("TaskUpdate owner assignment is allowed for blocked and completed tasks", async () => {
    const mainCtx = ctxFor();
    await TaskCreate.run(callFor({ subject: "blocker", description: "d" }), mainCtx);
    await TaskCreate.run(callFor({ subject: "target", description: "d" }), mainCtx);
    await TaskUpdate.run(callFor({ taskId: "2", addBlockedBy: ["1"] }), mainCtx);

    const blockedAssignment = await TaskUpdate.run(
      callFor({ taskId: "2", owner: "worker-a" }),
      mainCtx,
    );
    expect(String(blockedAssignment.content)).toBe("Updated task #2 owner");

    await TaskUpdate.run(callFor({ taskId: "1", status: "completed" }), mainCtx);
    const completedAssignment = await TaskUpdate.run(
      callFor({ taskId: "1", owner: "worker-b" }),
      mainCtx,
    );
    expect(String(completedAssignment.content)).toBe("Updated task #1 owner");
    expect(list()[0]?.owner).toBe("worker-b");
    expect(list()[1]?.owner).toBe("worker-a");
  });

  test("TaskUpdate parity texts: not-found, failed delete path, empty update, metadata always counts", async () => {
    const mainCtx = ctxFor();

    // Missing task: bare "Task not found" (no id), also for a delete request.
    const missing = await TaskUpdate.run(callFor({ taskId: "9", status: "completed" }), mainCtx);
    expect(String(missing.content)).toBe("Task not found");
    const missingDelete = await TaskUpdate.run(
      callFor({ taskId: "9", status: "deleted" }),
      mainCtx,
    );
    expect(String(missingDelete.content)).toBe("Task not found");

    await TaskCreate.run(callFor({ subject: "edges", description: "d" }), mainCtx);

    // No-op update joins to an empty field list with a trailing space.
    const noop = await TaskUpdate.run(callFor({ taskId: "1" }), mainCtx);
    expect(String(noop.content)).toBe("Updated task #1 ");
    const sameSubject = await TaskUpdate.run(callFor({ taskId: "1", subject: "edges" }), mainCtx);
    expect(String(sameSubject.content)).toBe("Updated task #1 ");

    // A provided metadata object always counts as updated, even when the
    // merge changes nothing, and precedes status in the field list.
    const metaNoop = await TaskUpdate.run(callFor({ taskId: "1", metadata: {} }), mainCtx);
    expect(String(metaNoop.content)).toBe("Updated task #1 metadata");
    const metaAndStatus = await TaskUpdate.run(
      callFor({ taskId: "1", metadata: { k: "v" }, status: "in_progress" }),
      mainCtx,
    );
    expect(String(metaAndStatus.content)).toBe("Updated task #1 metadata, status");

    // Existing task deletes keep the update text.
    const deleted = await TaskUpdate.run(callFor({ taskId: "1", status: "deleted" }), mainCtx);
    expect(String(deleted.content)).toBe("Updated task #1 deleted");
  });

  test("claimTask remains atomic for callers that use the claim API", async () => {
    const scope = `claim-race-${crypto.randomUUID()}`;
    create({ subject: "race", description: "d" }, scope);

    const results = await Promise.all([
      claimInWorker("worker-a", scope),
      claimInWorker("worker-b", scope),
    ]);

    expect(results.filter((result) => result.success === true)).toHaveLength(1);
    expect(
      results.filter((result) => result.success === false && result.reason === "already_claimed"),
    ).toHaveLength(1);
  });
});
