import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  _resetAsyncStopHooksForTests,
  ASYNC_REWAKE_FLUSH_TIMEOUT_MS,
  buildStopHookRewakeNotification,
  drainPendingAsyncRewakeHooks,
  isAsyncStopHook,
  launchAsyncStopHook,
} from "@/engine/queue/runtime/stop-hook-rewake.ts";
import type { CommandHookEntry } from "@/kernel/std/types/hook-entry.ts";

const SESSION = "sess-rewake-test";

function entry(overrides: Partial<CommandHookEntry> = {}): CommandHookEntry {
  return { matcher: "*", command: "true", ...overrides };
}

beforeEach(() => {
  emitQueue._resetForTests();
  _resetAsyncStopHooksForTests();
});

afterEach(() => {
  emitQueue._resetForTests();
  _resetAsyncStopHooksForTests();
});

describe("async stop-hook gates (reference Okd: (async || asyncRewake && interactive) && !forceSync)", () => {
  test("plain entry is not async", () => {
    expect(isAsyncStopHook({ entry: entry(), interactive: true, sessionId: SESSION })).toBe(false);
  });

  test("async backgrounds regardless of interactivity", () => {
    expect(
      isAsyncStopHook({ entry: entry({ async: true }), interactive: false, sessionId: SESSION }),
    ).toBe(true);
  });

  test("asyncRewake requires an interactive session", () => {
    const e = entry({ asyncRewake: true });
    expect(isAsyncStopHook({ entry: e, interactive: true, sessionId: SESSION })).toBe(true);
    expect(isAsyncStopHook({ entry: e, interactive: false, sessionId: SESSION })).toBe(false);
  });

  test("forceSyncExecution suppresses both flags", () => {
    expect(
      isAsyncStopHook({
        entry: entry({ async: true, asyncRewake: true }),
        interactive: true,
        forceSyncExecution: true,
        sessionId: SESSION,
      }),
    ).toBe(false);
  });
});

describe("rewake notification payload", () => {
  test("verbatim defaults: summary + prefixed stderr body", () => {
    const { text, summary } = buildStopHookRewakeNotification(
      entry({ command: "check.sh", asyncRewake: true }),
      { kind: "non_zero_exit", code: 2, stdout: "out", stderr: "lint failed" },
    );
    expect(summary).toBe("Stop hook feedback");
    expect(text).toBe(
      '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\nStop hook blocking error from command "Stop": lint failed',
    );
  });

  test("rewakeSummary and rewakeMessage override defaults; stdout used when stderr empty", () => {
    const { text, summary } = buildStopHookRewakeNotification(
      entry({
        command: "check.sh",
        asyncRewake: true,
        rewakeSummary: "Lint gate",
        rewakeMessage: "Custom prefix:",
      }),
      { kind: "non_zero_exit", code: 2, stdout: "stdout body", stderr: "" },
    );
    expect(summary).toBe("Lint gate");
    expect(text.endsWith("Custom prefix: stdout body")).toBe(true);
  });
});

describe("launchAsyncStopHook", () => {
  test("exit code 2 with asyncRewake enqueues urgent task-notification with autoTurn", async () => {
    const launched = launchAsyncStopHook({
      entry: entry({ command: "echo 'needs more work' >&2; exit 2", asyncRewake: true }),
      interactive: true,
      sessionId: SESSION,
    });
    expect(launched).toBe(true);
    await drainPendingAsyncRewakeHooks();
    const pending = emitQueue.peek({ class: "urgent_output" });
    expect(pending.length).toBe(1);
    const item = pending[0];
    expect(item?.payload.kind).toBe("task_notification_xml");
    if (item?.payload.kind !== "task_notification_xml") return;
    expect(item.payload.summary).toBe("Stop hook feedback");
    expect(item.payload.text).toContain("needs more work");
    expect(item.autoTurn).toBe(true);
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("exit code 0 is silent", async () => {
    launchAsyncStopHook({
      entry: entry({ command: "exit 0", asyncRewake: true }),
      interactive: true,
      sessionId: SESSION,
    });
    await drainPendingAsyncRewakeHooks();
    expect(emitQueue.peek().length).toBe(0);
  });

  test("exit code 1 (non-blocking) is silent", async () => {
    launchAsyncStopHook({
      entry: entry({ command: "echo err >&2; exit 1", asyncRewake: true }),
      interactive: true,
      sessionId: SESSION,
    });
    await drainPendingAsyncRewakeHooks();
    expect(emitQueue.peek().length).toBe(0);
  });

  test("plain async never rewakes even on exit 2", async () => {
    launchAsyncStopHook({
      entry: entry({ command: "exit 2", async: true }),
      interactive: true,
      sessionId: SESSION,
    });
    await drainPendingAsyncRewakeHooks();
    expect(emitQueue.peek().length).toBe(0);
  });

  test("non-async entry is not launched (caller keeps sync semantics)", () => {
    expect(launchAsyncStopHook({ entry: entry(), interactive: true, sessionId: SESSION })).toBe(
      false,
    );
  });

  test("flush constant pairs the reference ASYNC_REWAKE_FLUSH_TIMEOUT_MS", () => {
    expect(ASYNC_REWAKE_FLUSH_TIMEOUT_MS).toBe(30_000);
  });
});

describe("config passthrough (normalizeHooksConfig keeps async flags)", () => {
  test("stop entries carry async/asyncRewake/rewakeMessage/rewakeSummary", async () => {
    const { normalizeHooksConfig } = await import("@/kernel/config/config.ts");
    const hooks = normalizeHooksConfig({
      stop: [
        {
          matcher: "*",
          command: "./gate.sh",
          asyncRewake: true,
          rewakeMessage: "Gate said:",
          rewakeSummary: "Gate feedback",
        },
        { matcher: "*", command: "./bg.sh", async: true },
      ],
    });
    const stop = hooks?.stop ?? [];
    expect(stop.length).toBe(2);
    expect(stop[0]).toMatchObject({
      command: "./gate.sh",
      asyncRewake: true,
      rewakeMessage: "Gate said:",
      rewakeSummary: "Gate feedback",
    });
    expect(stop[1]).toMatchObject({ command: "./bg.sh", async: true });
    expect((stop[1] as { asyncRewake?: boolean }).asyncRewake).toBeUndefined();
  });
});
