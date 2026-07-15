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

function ctxFor(agentOwnerId?: string): RequestContext {
  return { sessionId: "sess-scope-test", cwd: "/dummy/cwd", agentOwnerId } as RequestContext;
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

describe("task tools share the session planning list", () => {
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

  test("a main-created task is visible and writable from a subagent context", async () => {
    const mainCtx = ctxFor();
    const agentCtx = ctxFor("fork_abc_1");
    await TaskCreate.run(callFor({ subject: "shared task", description: "d" }), mainCtx);

    const listed = await TaskList.run(callFor({}), agentCtx);
    const got = await TaskGet.run(callFor({ taskId: "1" }), agentCtx);
    const updated = await TaskUpdate.run(callFor({ taskId: "1", status: "in_progress" }), agentCtx);

    expect(String(listed.content)).toContain("shared task");
    expect(String(got.content)).toContain("Task #1: shared task");
    expect(String(updated.content)).toBe("Updated task #1 status");
    expect(list()[0]?.status).toBe("in_progress");
  });

  test("a subagent-created task lands in the shared session list", async () => {
    await TaskCreate.run(
      callFor({ subject: "agent task", description: "agent-shared" }),
      ctxFor("fork_abc_2"),
    );

    expect(list()).toHaveLength(1);
    expect(list()[0]?.subject).toBe("agent task");
    const mainView = await TaskList.run(callFor({}), ctxFor());
    expect(String(mainView.content)).toContain("agent task");
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
