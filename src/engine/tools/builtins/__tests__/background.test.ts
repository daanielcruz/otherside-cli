import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackgroundTask,
  SHELL_OUTPUT_TAIL_CAP,
  subscribeCompletion,
} from "@/engine/background/tasks/background.ts";
import { resolveTaskLogPath } from "@/engine/background/tasks/output-files.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { SpillBuffer } from "@/engine/tools/_infra/spill-buffer.ts";
import {
  type BackgroundShell,
  disposeShellStreams,
  killBackground,
  killShellsForOwner,
  newShellStreams,
  pollBackground,
  SHELLS,
  spawnBackground,
} from "../background.ts";
import { createBackgroundOutputLimiter } from "../background-output-limit.ts";
import { drainStream } from "../exec.ts";

const UNREACHED_DEADLINE_MS = 60_000;
const SHORT_DEADLINE_MS = 50;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

const shellIds: string[] = [];
const tempDirs: string[] = [];

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

afterEach(() => {
  for (const id of shellIds.splice(0)) {
    const shell = SHELLS.get(id);
    if (shell) disposeShellStreams(shell);
    SHELLS.delete(id);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBuffer(): SpillBuffer {
  const dir = mkdtempSync(join(tmpdir(), "background-output-limit-test-"));
  tempDirs.push(dir);
  return new SpillBuffer({ path: join(dir, "stream.spill") });
}

function stringToStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

function registerShell(id: string): BackgroundShell {
  const shell: BackgroundShell = {
    id,
    command: "large output",
    startedAt: Date.now(),
    ...newShellStreams(id),
    status: "running",
    exitCode: null,
    child: null,
  };
  shellIds.push(id);
  SHELLS.set(id, shell);
  return shell;
}

describe("background shell watchdog lifecycle", () => {
  it("stops watchdogs when shell streams are disposed", () => {
    const shell = registerShell("dispose-watchdog");
    let stops = 0;
    shell.stopWatchdog = () => {
      stops += 1;
    };

    disposeShellStreams(shell);

    expect(stops).toBe(1);
  });

  it("stops the agent shell cap when shell streams are disposed", () => {
    const shell = registerShell("dispose-subagent-cap");
    let stops = 0;
    shell.stopSubagentCap = () => {
      stops += 1;
    };

    disposeShellStreams(shell);

    expect(stops).toBe(1);
  });

  it("stops watchdogs when a background shell is killed", () => {
    const shell = registerShell("kill-watchdog");
    let stops = 0;
    shell.stopWatchdog = () => {
      stops += 1;
    };

    expect(killBackground(shell.id)).toEqual({ ok: true });
    expect(stops).toBe(2);
  });
});

describe("background output limiter", () => {
  it("shares one UTF-8 byte budget across streams and rejects after the boundary", () => {
    let exceeded = 0;
    const accept = createBackgroundOutputLimiter({
      maxBytes: Buffer.byteLength("outerr", "utf8"),
      onExceeded: () => {
        exceeded++;
      },
    });

    expect(accept("out")).toBe(true);
    expect(accept("err")).toBe(true);
    expect(accept("")).toBe(true);
    expect(accept("more")).toBe(false);
    expect(accept("later")).toBe(false);
    expect(exceeded).toBe(1);
  });

  it("counts UTF-8 bytes rather than JavaScript string length", () => {
    let exceeded = 0;
    const accept = createBackgroundOutputLimiter({
      maxBytes: 4,
      onExceeded: () => {
        exceeded++;
      },
    });

    expect(accept("🙂")).toBe(true);
    expect(accept("a")).toBe(false);
    expect(exceeded).toBe(1);
  });

  it("drops rejected drain chunks before the spill buffer and callback", async () => {
    const buffer = makeBuffer();
    const seen: string[] = [];

    await drainStream(stringToStream(["accepted", "rejected"]), {
      buffer,
      acceptChunk: (chunk) => chunk !== "rejected",
      onChunk: (chunk) => seen.push(chunk),
    });

    expect(buffer.snapshot()).toBe("accepted");
    expect(seen).toEqual(["accepted"]);
    buffer.dispose();
  });
});

describe("spawnBackground completion", () => {
  it("waits for post-exit stream drains before snapshotting and closing the log", async () => {
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout,
      stderr: stringToStream([]),
      exited,
      pid: 123_456,
      kill: () => {},
    } as never);
    let taskId = "";
    let unsubscribe = () => {};
    const completed = new Promise<string>((resolve) => {
      unsubscribe = subscribeCompletion((task) => {
        if (task.id !== taskId) return;
        unsubscribe();
        resolve(task.result?.content ?? "");
      });
    });

    try {
      const spawned = spawnBackground({
        execCommand: "ignored",
        command: "ignored",
        displayCommand: "post-exit drain test",
        parentToolCallId: "call-post-exit-drain",
        cwd: process.cwd(),
        timeoutMs: UNREACHED_DEADLINE_MS,
      });
      expect("error" in spawned).toBe(false);
      if ("error" in spawned) return;
      taskId = spawned.id;
      shellIds.push(taskId);
      expect(SHELLS.get(taskId)?.stopWatchdog).toBeFunction();

      resolveExit(0);
      await Promise.resolve();
      stdoutController?.enqueue(new TextEncoder().encode("late tail\n"));
      stdoutController?.close();

      expect(await completed).toContain("late tail");
      expect(SHELLS.get(taskId)?.stopWatchdog).toBeUndefined();
      expect(readFileSync(resolveTaskLogPath(taskId), "utf8")).toContain("late tail");
    } finally {
      unsubscribe();
      spawnSpy.mockRestore();
    }
  });

  it("does not double-complete when owner cleanup disposes streams before exit", async () => {
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout,
      stderr: stringToStream([]),
      exited,
      pid: 123_458,
      kill: () => {},
    } as never);
    let completions = 0;
    let taskId = "";
    const unsubscribe = subscribeCompletion((task) => {
      if (task.id === taskId) completions++;
    });

    try {
      const spawned = spawnBackground({
        execCommand: "ignored",
        command: "ignored",
        displayCommand: "owner cleanup drain test",
        parentToolCallId: "call-owner-cleanup-drain",
        ownerId: "owner-cleanup-test",
        cwd: process.cwd(),
        timeoutMs: UNREACHED_DEADLINE_MS,
      });
      expect("error" in spawned).toBe(false);
      if ("error" in spawned) return;
      taskId = spawned.id;

      expect(killShellsForOwner("owner-cleanup-test")).toBe(1);
      expect(completions).toBe(1);
      resolveExit(143);
      stdoutController?.enqueue(new TextEncoder().encode("ignored after dispose"));
      stdoutController?.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(completions).toBe(1);
    } finally {
      unsubscribe();
      spawnSpy.mockRestore();
    }
  });
});

describe("spawnBackground deadline", () => {
  afterEach(() => {
    emitQueue._resetForTests();
  });

  function spawnUntilCompletion(command: string, timeoutMs: number) {
    let taskId = "";
    let unsubscribe = () => {};
    const completed = new Promise<BackgroundTask>((resolve) => {
      unsubscribe = subscribeCompletion((task) => {
        if (task.id !== taskId) return;
        unsubscribe();
        resolve(task);
      });
    });
    const spawned = spawnBackground({
      execCommand: command,
      command,
      displayCommand: "<description>",
      parentToolCallId: `call-${crypto.randomUUID()}`,
      cwd: process.cwd(),
      timeoutMs,
    });
    if ("error" in spawned) throw new Error(spawned.error);
    taskId = spawned.id;
    shellIds.push(taskId);
    return { taskId, completed };
  }

  function notificationText(taskId: string): string | undefined {
    const item = emitQueue
      .peek({ class: "deferred_output" })
      .find((queued) => queued.replayKey?.startsWith(`bg:${taskId}:`));
    return item?.payload.kind === "task_notification_xml" ? item.payload.text : undefined;
  }

  it("stops a shell still running when its deadline passes", async () => {
    const { completed } = spawnUntilCompletion("sleep 30", SHORT_DEADLINE_MS);

    const task = await completed;

    expect(task.status).toBe("killed");
    expect(task.stopCause).toBe("deadline");
  });

  it("notifies the deadline stop with its summary and note", async () => {
    const { taskId, completed } = spawnUntilCompletion("sleep 30", SHORT_DEADLINE_MS);

    await completed;

    const text = notificationText(taskId);
    expect(text).toContain(
      '<summary>Background command "&lt;description&gt;" was stopped after reaching its background time limit</summary>',
    );
    expect(text).toContain(
      "<note>If the work in progress still needs it, start it again with `run_in_background` and a longer `timeout`. If it already had the longest `timeout` allowed, do not restart it. Either way, report that it was stopped.</note>",
    );
  });

  it("clears the deadline when the shell exits first", async () => {
    const { taskId, completed } = spawnUntilCompletion("true", UNREACHED_DEADLINE_MS);

    const task = await completed;

    expect(task.status).toBe("completed");
    expect(SHELLS.get(taskId)?.stopDeadline).toBeUndefined();
  });
});

describe("pollBackground", () => {
  it("drains only the retained output tail for a large unread range", () => {
    const shell = registerShell("b-large-output-test");

    shell.stdout.buffer.append(`${"a".repeat(SHELL_OUTPUT_TAIL_CAP + 500_000)}THE_END`);

    const polled = pollBackground(shell.id, null);

    expect("error" in polled).toBe(false);
    if ("error" in polled) return;
    expect(polled.stdout).toHaveLength(SHELL_OUTPUT_TAIL_CAP);
    expect(polled.stdout.endsWith("THE_END")).toBe(true);
    expect(shell.stdout.cursor).toBe(shell.stdout.buffer.length);
  });

  it("does not start a capped drain with a low surrogate", () => {
    const shell = registerShell("b-large-output-surrogate-test");

    shell.stdout.buffer.append(`X🙂${"b".repeat(SHELL_OUTPUT_TAIL_CAP - 1)}`);

    const polled = pollBackground(shell.id, null);

    expect("error" in polled).toBe(false);
    if ("error" in polled) return;
    expect(polled.stdout).toHaveLength(SHELL_OUTPUT_TAIL_CAP - 1);
    expect(isLowSurrogate(polled.stdout.charCodeAt(0))).toBe(false);
    expect(polled.stdout).toBe("b".repeat(SHELL_OUTPUT_TAIL_CAP - 1));
    expect(shell.stdout.cursor).toBe(shell.stdout.buffer.length);
  });
});
