import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  get as getBackgroundTask,
  subscribeCompletion,
} from "@/engine/background/tasks/background.ts";
import { runForegroundWithAutoBg } from "../auto-bg.ts";
import { killBackground, listBackground, SHELLS } from "../background.ts";
import { isAutoBackgroundableCommand } from "../safety.ts";

afterEach(() => {
  for (const shell of listBackground()) {
    killBackground(shell.id);
  }
});

describe("isAutoBackgroundableCommand", () => {
  it("excludes git invocations", () => {
    expect(isAutoBackgroundableCommand("git")).toBe(false);
    expect(isAutoBackgroundableCommand("git push origin main")).toBe(false);
    expect(isAutoBackgroundableCommand("/usr/local/bin/git push")).toBe(false);
    expect(isAutoBackgroundableCommand("xargs git push")).toBe(false);
    expect(isAutoBackgroundableCommand("echo git push")).toBe(true);
  });
});

describe("runForegroundWithAutoBg", () => {
  it("captures post-exit output in a promoted task result", async () => {
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
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout,
      stderr,
      exited,
      pid: 123_457,
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
      const outcome = await runForegroundWithAutoBg({
        command: "ignored",
        displayCommand: "promoted post-exit drain test",
        parentToolCallId: "call-promoted-post-exit-drain",
        timeoutMs: 10_000,
        cwd: process.cwd(),
        userBgSignaled: Promise.resolve(),
      });
      expect(outcome.promoted).toBe(true);
      if (!outcome.promoted) return;
      taskId = outcome.shellId;
      expect(SHELLS.get(taskId)?.stopWatchdog).toBeFunction();

      resolveExit(0);
      await Promise.resolve();
      stdoutController?.enqueue(new TextEncoder().encode("promoted late tail\n"));
      stdoutController?.close();

      expect(await completed).toContain("promoted late tail");
      expect(SHELLS.get(taskId)?.stopWatchdog).toBeUndefined();
    } finally {
      unsubscribe();
      spawnSpy.mockRestore();
    }
  });

  it("detaches the foreground abort listener after promotion", async () => {
    const controller = new AbortController();
    const originalRemoveEventListener = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    let removedAbortListener = false;
    controller.signal.removeEventListener = ((type, listener, options) => {
      if (type === "abort") removedAbortListener = true;
      return originalRemoveEventListener(type, listener, options);
    }) as AbortSignal["removeEventListener"];

    const outcome = await runForegroundWithAutoBg({
      command: 'bun -e "setTimeout(() => {}, 5000)"',
      displayCommand: "long-running test command",
      parentToolCallId: "call_test",
      timeoutMs: 10_000,
      cwd: process.cwd(),
      signal: controller.signal,
      userBgSignaled: Promise.resolve(),
    });

    expect(outcome.promoted).toBe(true);
    expect(removedAbortListener).toBe(true);
  });

  it("stamps sessionId on the promoted background shell task", async () => {
    const sessionId = "session-promoted-shell";
    const outcome = await runForegroundWithAutoBg({
      command: 'bun -e "setTimeout(() => {}, 5000)"',
      displayCommand: "promoted session stamp test",
      parentToolCallId: "call-promoted-session-stamp",
      timeoutMs: 10_000,
      cwd: process.cwd(),
      sessionId,
      userBgSignaled: Promise.resolve(),
    });

    expect(outcome.promoted).toBe(true);
    if (!outcome.promoted) return;
    expect(getBackgroundTask(outcome.shellId)?.sessionId).toBe(sessionId);
  });
});
