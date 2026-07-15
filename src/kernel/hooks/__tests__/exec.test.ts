import { describe, expect, it, spyOn } from "bun:test";
import { fireEntry } from "../exec.ts";

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe("command hook timer lifecycle", () => {
  it("clears the execution timeout when the process finishes first", async () => {
    const timeoutHandle = {} as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      (() => timeoutHandle) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: emptyStream(),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill: () => {},
    } as never);

    try {
      const outcome = await fireEntry(
        { matcher: "", command: "true" },
        { kind: "stop", ctx: { sessionId: "test" } },
        60_000,
      );
      expect(outcome.kind).toBe("ok");
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      spawnSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});
