import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BackgroundTask, subscribeCompletion } from "@/engine/background/tasks/background.ts";
import { getRuntimeKind, setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { killBackground, listBackground } from "../background.ts";
import { Bash } from "../bash.ts";

const DEADLINE_NOTICE =
  "If it is still running after 30m in the background, it will be stopped and you will be notified.";
const SHORT_TIMEOUT_MS = 50;

const runtimeBefore = getRuntimeKind();

afterEach(() => {
  for (const shell of listBackground()) killBackground(shell.id);
  setRuntimeKind(runtimeBefore);
});

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "anthropic",
    model: "<model>",
    effort: null,
    permissionMode: "yolo",
    sessionId: `<session>-${crypto.randomUUID()}`,
    cwd: process.cwd(),
    originalCwd: process.cwd(),
    subagentLabel: "<agent>",
    agentOwnerId: `<owner>-${crypto.randomUUID()}`,
    ...overrides,
  };
}

async function runBash(input: Record<string, unknown>, ctx = context()): Promise<ToolResult> {
  const call: ToolCall = {
    id: `call-${crypto.randomUUID()}`,
    name: "Bash",
    input: { dangerouslyDisableSandbox: true, ...input },
  };
  return Bash.run(call, ctx);
}

function completionOf(taskId: string): Promise<BackgroundTask> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeCompletion((task) => {
      if (task.id !== taskId) return;
      unsubscribe();
      resolve(task);
    });
  });
}

function shellId(result: ToolResult): string {
  const id = result.meta?.kind === "bash" ? result.meta.shell_id : undefined;
  if (typeof id !== "string") throw new Error("expected a background shell id");
  return id;
}

describe("Bash background time limit", () => {
  beforeEach(() => {
    setRuntimeKind("print");
  });

  test("stops a run_in_background command once its timeout passes", async () => {
    const result = await runBash({
      command: "sleep 30",
      run_in_background: true,
      timeout: SHORT_TIMEOUT_MS,
    });

    const task = await completionOf(shellId(result));

    expect(task.status).toBe("killed");
    expect(task.stopCause).toBe("deadline");
  });

  test("a command started in the background is not told about the moved-command limit", async () => {
    const result = await runBash({ command: "sleep 30", run_in_background: true });

    expect(result.content).not.toContain(DEADLINE_NOTICE);
  });

  test("a command moved to the background is told when it will be stopped", async () => {
    const ctx = context({
      backgroundController: {
        signal: () => {},
        isBackgrounded: () => false,
        signaled: Promise.resolve(),
      },
    });

    const result = await runBash({ command: "sleep 30" }, ctx);

    expect(String(result.content).endsWith(` ${DEADLINE_NOTICE}`)).toBe(true);
  });
});

describe("Bash background shells in an interactive session", () => {
  beforeEach(() => {
    setRuntimeKind("interactive");
  });

  test("a run_in_background command keeps running past its timeout", async () => {
    const result = await runBash({
      command: "sleep 30",
      run_in_background: true,
      timeout: SHORT_TIMEOUT_MS,
    });
    await Bun.sleep(SHORT_TIMEOUT_MS * 4);

    expect(listBackground().find((shell) => shell.id === shellId(result))?.status).toBe("running");
  });

  test("a command moved to the background is not told about a limit", async () => {
    const ctx = context({
      backgroundController: {
        signal: () => {},
        isBackgrounded: () => false,
        signaled: Promise.resolve(),
      },
    });

    const result = await runBash({ command: "sleep 30" }, ctx);

    expect(result.content).not.toContain("it will be stopped");
  });
});
