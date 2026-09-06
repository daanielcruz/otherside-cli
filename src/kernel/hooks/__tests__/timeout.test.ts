import { describe, expect, spyOn, test } from "bun:test";
import { HOOK_EVENT_VALUES, type HookEvent } from "../events.ts";
import { fireEntry } from "../exec.ts";
import {
  defaultHookTimeoutSeconds,
  HOOK_TIMEOUT_SECONDS,
  hookTimeoutMs,
  TOOL_HOOK_TIMEOUT_SECONDS,
} from "../timeout.ts";

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe("hook timeout contract", () => {
  test("tool hooks default to the long budget, every other event to the short one", () => {
    expect(defaultHookTimeoutSeconds("preToolUse")).toBe(TOOL_HOOK_TIMEOUT_SECONDS);
    const toolEvents = new Set<HookEvent>([
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "postToolBatch",
      "permissionRequest",
    ]);
    for (const event of toolEvents) {
      expect(defaultHookTimeoutSeconds(event)).toBe(TOOL_HOOK_TIMEOUT_SECONDS);
    }
    expect(TOOL_HOOK_TIMEOUT_SECONDS).toBe(600);
    expect(HOOK_TIMEOUT_SECONDS).toBe(60);

    for (const event of HOOK_EVENT_VALUES) {
      if (toolEvents.has(event)) continue;
      expect(defaultHookTimeoutSeconds(event)).toBe(HOOK_TIMEOUT_SECONDS);
    }
  });

  test("a declared timeout is read as seconds and wins over the default", () => {
    expect(hookTimeoutMs({ matcher: "*", command: "true", timeout: 5 }, "preToolUse")).toBe(5_000);
    expect(hookTimeoutMs({ matcher: "*", command: "true", timeout: 0.5 }, "stop")).toBe(500);
  });

  test("an absent or unusable timeout falls back to the per-event default", () => {
    expect(hookTimeoutMs({ matcher: "*", command: "true" }, "preToolUse")).toBe(600_000);
    expect(hookTimeoutMs({ matcher: "*", command: "true" }, "sessionStart")).toBe(60_000);
    expect(hookTimeoutMs({ matcher: "*", command: "true", timeout: 0 }, "stop")).toBe(60_000);
    expect(hookTimeoutMs({ matcher: "*", command: "true", timeout: -3 }, "postToolUse")).toBe(
      600_000,
    );
    expect(
      hookTimeoutMs({ matcher: "*", command: "true", timeout: Number.NaN }, "sessionEnd"),
    ).toBe(60_000);
  });

  test("the runner arms the timer with the resolved per-event budget", async () => {
    const timeoutHandle = {} as ReturnType<typeof setTimeout>;
    const armed: number[] = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      _fn: unknown,
      ms: number,
    ) => {
      armed.push(ms);
      return timeoutHandle;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: emptyStream(),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill: () => {},
    } as never);

    try {
      await fireEntry(
        { matcher: "", command: "true" },
        {
          kind: "preToolUse",
          ctx: { toolName: "Bash", toolInput: "{}" },
        },
      );
      await fireEntry(
        { matcher: "", command: "true" },
        {
          kind: "stop",
          ctx: { sessionId: "s" },
        },
      );
      await fireEntry(
        { matcher: "", command: "true", timeout: 3 },
        {
          kind: "stop",
          ctx: { sessionId: "s" },
        },
      );

      expect(armed).toEqual([600_000, 60_000, 3_000]);
    } finally {
      spawnSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});
