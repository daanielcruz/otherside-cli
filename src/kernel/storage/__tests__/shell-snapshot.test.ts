import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { resetShellCache } from "@/kernel/std/proc/shell.ts";
import { getShellSnapshotPath, resetShellSnapshotForTests } from "../shell-snapshot.ts";

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

const originalShell = process.env.SHELL;

afterEach(() => {
  resetShellSnapshotForTests();
  resetShellCache();
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

describe("shell snapshot timer lifecycle", () => {
  it("clears the creation timeout when stderr reading fails", async () => {
    if (process.platform === "win32") return;
    process.env.SHELL = "/bin/bash";
    resetShellCache();
    const timeoutHandle = {} as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => timeoutHandle) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: emptyStream(),
      stderr: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("stderr read failed");
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {},
    } as never);

    try {
      expect(await getShellSnapshotPath()).toBeNull();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      spawnSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("bounds a snapshot whose process and stderr stream never settle", async () => {
    if (process.platform === "win32") return;
    process.env.SHELL = "/bin/bash";
    resetShellCache();
    let fireTimeout: (() => void) | undefined;
    let announceArmed: () => void = () => {};
    const armed = new Promise<void>((resolve) => {
      announceArmed = resolve;
    });
    const timeoutHandle = {} as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
    ) => {
      fireTimeout = callback;
      announceArmed();
      return timeoutHandle;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    let kills = 0;
    let streamCancels = 0;
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: emptyStream(),
      stderr: new ReadableStream<Uint8Array>({
        cancel() {
          streamCancels++;
        },
      }),
      exited: new Promise<number | null>(() => {}),
      kill: () => {
        kills++;
      },
    } as never);

    try {
      const snapshot = getShellSnapshotPath();
      await armed;
      fireTimeout?.();
      expect(await snapshot).toBeNull();
      expect(kills).toBe(1);
      expect(streamCancels).toBe(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      spawnSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});
