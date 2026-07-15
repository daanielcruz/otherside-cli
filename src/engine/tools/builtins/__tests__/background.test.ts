import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHELL_OUTPUT_TAIL_CAP,
  subscribeCompletion,
} from "@/engine/background/tasks/background.ts";
import { getTaskOutputPath } from "@/engine/background/tasks/output-files.ts";
import { SpillBuffer } from "@/engine/tools/_infra/spill-buffer.ts";
import {
  type BackgroundShell,
  disposeShellStreams,
  killShellsForOwner,
  newShellStreams,
  pollBackground,
  SHELLS,
  spawnBackground,
} from "../background.ts";
import { createBackgroundOutputLimiter } from "../background-output-limit.ts";
import { drainStream } from "../exec.ts";

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
      });
      expect("error" in spawned).toBe(false);
      if ("error" in spawned) return;
      taskId = spawned.id;
      shellIds.push(taskId);

      resolveExit(0);
      await Promise.resolve();
      stdoutController?.enqueue(new TextEncoder().encode("late tail\n"));
      stdoutController?.close();

      expect(await completed).toContain("late tail");
      expect(readFileSync(getTaskOutputPath(taskId), "utf8")).toContain("late tail");
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
