import { afterEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  appendShellOutput,
  clear,
  completeTask,
  markTaskNotified,
  removeTask,
  startShellTask,
} from "../background.ts";
import {
  finalLineRequestsInput,
  type StallWatchdogTimerApi,
  watchForInteractiveWait,
} from "../stall-watchdog.ts";

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  clears: number;
  unrefs: number;
  active: boolean;
  unref?: () => void;
}

function createTimerApi(withUnref = true): {
  api: StallWatchdogTimerApi;
  timers: FakeTimer[];
  tick: (index?: number) => void;
} {
  const timers: FakeTimer[] = [];
  const api: StallWatchdogTimerApi = {
    setInterval(callback, delayMs) {
      const timer: FakeTimer = {
        callback,
        delayMs,
        clears: 0,
        unrefs: 0,
        active: true,
      };
      if (withUnref) {
        timer.unref = () => {
          timer.unrefs += 1;
        };
      }
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) {
      const timer = handle as unknown as FakeTimer;
      timer.clears += 1;
      timer.active = false;
    },
  };
  return {
    api,
    timers,
    tick: (index = 0) => timers[index]?.callback(),
  };
}

function registerShell(id: string, output = ""): void {
  startShellTask({
    shellId: id,
    command: "installer",
    displayCommand: "interactive installer",
    parentToolCallId: `call-${id}`,
  });
  appendShellOutput(id, output);
}

function urgentNotifications(): Array<
  ReturnType<typeof emitQueue.peek>[number] & {
    payload: { kind: "task_notification_xml"; text: string; summary: string };
  }
> {
  return emitQueue
    .peek({ class: "urgent_output" })
    .filter((item) => item.payload.kind === "task_notification_xml") as Array<
    ReturnType<typeof emitQueue.peek>[number] & {
      payload: { kind: "task_notification_xml"; text: string; summary: string };
    }
  >;
}

function startHarness(input: {
  taskId: string;
  time?: number;
  thresholdMs?: number;
  withUnref?: boolean;
  toolUseId?: string;
}) {
  let time = input.time ?? 1_000;
  const fake = createTimerApi(input.withUnref);
  const stop = watchForInteractiveWait({
    taskId: input.taskId,
    now: () => time,
    intervalMs: 123,
    thresholdMs: input.thresholdMs ?? 45_000,
    timerApi: fake.api,
    ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
  });
  return {
    ...fake,
    stop,
    setTime: (next: number) => {
      time = next;
    },
    advance: (delta: number) => {
      time += delta;
    },
  };
}

afterEach(() => {
  clear();
  emitQueue._resetForTests();
});

describe("interactive-output prompt recognition", () => {
  test.each([
    "Continue?",
    "Overwrite?",
    "Proceed (y/n)",
    "Proceed [Y/n]",
    "Proceed (yes/no)",
    "Do you want to continue?",
    "Would you install this?   ",
    "Shall I proceed?",
    "Are you sure?",
    "Ready to deploy?",
    "Press any key",
    "Press Enter",
  ])("recognizes %s on the last line", (output) => {
    expect(finalLineRequestsInput(`earlier output\n${output}`)).toBe(true);
  });

  test("ignores prompt text before a non-prompt final line", () => {
    expect(finalLineRequestsInput("Continue?\nbuilding package")).toBe(false);
  });

  test("uses only the last line of multi-line output", () => {
    expect(finalLineRequestsInput("build complete\nProceed (y/n)\n\n")).toBe(true);
  });
});

describe("interactive-output stall scheduling", () => {
  test("arms at the default interval and unrefs when supported", () => {
    registerShell("defaults");
    const fake = createTimerApi();
    watchForInteractiveWait({ taskId: "defaults", timerApi: fake.api });

    expect(fake.timers).toHaveLength(1);
    expect(fake.timers[0]?.delayMs).toBe(5_000);
    expect(fake.timers[0]?.unrefs).toBe(1);
  });

  test("arms successfully when interval handles cannot unref", () => {
    registerShell("no-unref");
    const harness = startHarness({ taskId: "no-unref", withUnref: false });

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.unrefs).toBe(0);
  });

  test("does nothing while the task is absent", () => {
    const harness = startHarness({ taskId: "missing", thresholdMs: 0 });
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
    expect(harness.timers[0]?.active).toBe(true);
  });

  test("does nothing for every non-running state", () => {
    for (const status of ["completed", "error", "killed"] as const) {
      const id = `terminal-${status}`;
      registerShell(id, "Continue?");
      completeTask(id, {
        content: status,
        isError: status === "error",
        killed: status === "killed",
      });
      const harness = startHarness({ taskId: id, thresholdMs: 0 });
      harness.tick();
      expect(urgentNotifications()).toHaveLength(0);
    }
  });

  test("does nothing when the running task was already notified", () => {
    registerShell("notified", "Continue?");
    markTaskNotified("notified");
    const harness = startHarness({ taskId: "notified", thresholdMs: 0 });
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
  });

  test("records growth on each tick and waits a full quiet period", () => {
    registerShell("growing", "a");
    const harness = startHarness({ taskId: "growing" });

    harness.tick();
    harness.advance(20_000);
    appendShellOutput("growing", "b");
    harness.tick();
    harness.advance(20_000);
    appendShellOutput("growing", "c");
    harness.tick();
    harness.advance(44_999);
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
    expect(harness.timers[0]?.active).toBe(true);
  });

  test("waits at threshold minus one and evaluates at the exact threshold", () => {
    registerShell("boundary", "Continue?");
    const harness = startHarness({ taskId: "boundary" });
    harness.tick();

    harness.advance(44_999);
    harness.tick();
    expect(urgentNotifications()).toHaveLength(0);

    harness.advance(1);
    harness.tick();
    expect(urgentNotifications()).toHaveLength(1);
  });

  test("restarts the quiet clock after a non-prompt threshold check", () => {
    registerShell("rearm", "working");
    const harness = startHarness({ taskId: "rearm" });
    harness.tick();
    harness.advance(45_001);
    harness.tick();
    appendShellOutput("rearm", "\nContinue?");
    harness.tick();
    harness.advance(44_999);
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
    harness.advance(1);
    harness.tick();
    expect(urgentNotifications()).toHaveLength(1);
  });

  test("emits exact one-shot envelope and statusless notification text", () => {
    registerShell("notify", "special <value>\nProceed (y/n)\n");
    const harness = startHarness({ taskId: "notify", thresholdMs: 0, toolUseId: "tool-9" });
    harness.tick();
    harness.tick();

    const items = urgentNotifications();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      class: "urgent_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        summary:
          'Background command "interactive installer" appears to be waiting for interactive input',
      },
    });
    expect(items[0]?.replayKey).toMatch(/^stall:notify:\d+$/);
    expect(items[0]?.payload.text).toContain("<task-id>notify</task-id>");
    expect(items[0]?.payload.text).toContain("<tool-use-id>tool-9</tool-use-id>");
    expect(items[0]?.payload.text).toContain("<output-file>");
    expect(items[0]?.payload.text).not.toContain("<status>");
    expect(items[0]?.payload.text).toContain("Last output:\nspecial <value>\nProceed (y/n)");
    expect(items[0]?.payload.text).toContain(
      "Stop this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.",
    );
    expect(harness.timers[0]?.clears).toBe(1);
    expect(harness.timers[0]?.active).toBe(false);
  });

  test("keeps each task timer and notification independent", () => {
    registerShell("task-a", "Continue?");
    registerShell("task-b", "Overwrite?");
    const a = startHarness({ taskId: "task-a", thresholdMs: 0 });
    const b = startHarness({ taskId: "task-b", thresholdMs: 0 });

    a.tick();
    a.tick();
    expect(urgentNotifications()).toHaveLength(1);
    expect(b.timers[0]?.active).toBe(true);
    b.tick();
    b.tick();

    const keys = urgentNotifications().map((item) => item.replayKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^stall:task-a:\d+$/);
    expect(keys[1]).toMatch(/^stall:task-b:\d+$/);
  });

  test("stop cancels before threshold and remains exact on repeated calls", () => {
    registerShell("stopped", "Continue?");
    const harness = startHarness({ taskId: "stopped", thresholdMs: 0 });

    harness.stop();
    harness.stop();
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
    expect(harness.timers[0]?.clears).toBe(2);
  });

  test("preserves growth timing through backward and forward clock jumps", () => {
    registerShell("jumps", "Continue?");
    const harness = startHarness({ taskId: "jumps", time: 10_000 });
    harness.tick();

    harness.setTime(-100_000);
    harness.tick();
    expect(urgentNotifications()).toHaveLength(0);

    harness.setTime(55_000);
    harness.tick();
    expect(urgentNotifications()).toHaveLength(1);
  });

  test("inspects only the final 1024 characters", () => {
    registerShell("tail-bound", `Continue?\n${"x".repeat(1024)}`);
    const harness = startHarness({ taskId: "tail-bound", thresholdMs: 0 });
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
    appendShellOutput("tail-bound", "\nContinue?");
    harness.tick();
    harness.tick();
    expect(urgentNotifications()[0]?.payload.text).not.toContain("x".repeat(1024));
  });

  test("stable capped output retains the original greatest-length semantics", () => {
    registerShell("capped", "x".repeat(200_000));
    const harness = startHarness({ taskId: "capped", thresholdMs: 10 });
    harness.tick();
    appendShellOutput("capped", `Continue?${"z".repeat(199_991)}`);
    harness.advance(10);
    harness.tick();

    expect(urgentNotifications()).toHaveLength(0);
  });

  test("same-id task replacement remains observed by the existing timer", () => {
    registerShell("replace", "working");
    const harness = startHarness({ taskId: "replace", thresholdMs: 0 });
    harness.tick();
    removeTask("replace");
    registerShell("replace", "Continue?");
    harness.tick();
    harness.tick();

    expect(urgentNotifications()).toHaveLength(1);
  });

  test("double arm creates independent intervals and notifications", () => {
    registerShell("double", "Continue?");
    const first = startHarness({ taskId: "double", thresholdMs: 0 });
    const second = startHarness({ taskId: "double", thresholdMs: 0 });

    first.tick();
    first.tick();
    second.tick();
    second.tick();

    expect(urgentNotifications()).toHaveLength(2);
    expect(first.timers[0]?.clears).toBe(1);
    expect(second.timers[0]?.clears).toBe(1);
  });
});
