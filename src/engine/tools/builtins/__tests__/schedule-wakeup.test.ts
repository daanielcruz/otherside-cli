import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";
import { resetLoopRuntimeForTests } from "@/engine/background/loop/dynamic.ts";
import { ScheduleWakeup } from "@/engine/tools/builtins/schedule-wakeup.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const FIXED_NOW = new Date("2026-01-15T12:00:10");
const ctx = {} as RequestContext;
const VALID = { delaySeconds: 600, reason: "watching CI", prompt: "check build", noop: true };

let project: string;

function call(input: Record<string, unknown>, id = "wake-1"): ToolCall {
  return { id, name: "ScheduleWakeup", input };
}

function wakeups(): cron.ScheduledTask[] {
  return cron.tasks().filter((task) => task.kind === "loop");
}

describe("ScheduleWakeup", () => {
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "schedule-wakeup-"));
    cron.useProjectRootForTests(project);
    resetLoopRuntimeForTests();
    setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    setSystemTime();
    resetLoopRuntimeForTests();
    cron.useProjectRootForTests(null);
    rmSync(project, { recursive: true, force: true });
  });

  it("arms the next wakeup, tells the model to report before ending the turn", async () => {
    const result = await ScheduleWakeup.run(call({ ...VALID, delaySeconds: 1 }), ctx);

    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe(
      "Next wakeup scheduled for 12:02:00 (in 110s) (clamped to 60s from your requested value). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.",
    );
    expect(wakeups()).toEqual([
      expect.objectContaining({ prompt: "check build", reason: "watching CI", durable: false }),
    ]);
  });

  it("replaces the pending wakeup", async () => {
    await ScheduleWakeup.run(call(VALID), ctx);
    await ScheduleWakeup.run(call({ ...VALID, prompt: "check again" }, "wake-2"), ctx);
    expect(wakeups().map((task) => task.prompt)).toEqual(["check again"]);
  });

  it("stop:true cancels the pending wakeup and asks for the loop's outcome", async () => {
    await ScheduleWakeup.run(call(VALID), ctx);
    const stopped = await ScheduleWakeup.run(call({ stop: true, delaySeconds: 5 }, "stop"), ctx);

    expect(stopped.is_error).toBeUndefined();
    expect(stopped.content).toBe(
      "Loop stopped — cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. Then write the loop's outcome for the user as ordinary visible response text — and end the turn.",
    );
    expect(wakeups()).toEqual([]);
  });

  it("stop:true with nothing pending points at CronDelete for a fixed-interval loop", async () => {
    const stopped = await ScheduleWakeup.run(call({ stop: true }), ctx);
    expect(stopped.content).toContain("there was no pending wakeup to cancel");
    expect(stopped.content).toContain("cancel it with CronDelete");
    expect(stopped.content).toContain("write the loop's outcome for the user");
  });

  it("requires every field, noop included, unless stopping", async () => {
    const missing = async (field: keyof typeof VALID) => {
      const { [field]: _dropped, ...rest } = VALID;
      return ScheduleWakeup.run(call(rest), ctx);
    };
    expect((await missing("delaySeconds")).content).toBe(
      "`delaySeconds` and `reason` are required when `stop` is not true.",
    );
    expect((await missing("prompt")).content).toBe("`prompt` is required when `stop` is not true.");
    const noNoop = await missing("noop");
    expect(noNoop.is_error).toBe(true);
    expect(noNoop.content).toBe("`noop` is required when `stop` is not true.");
    const badNoop = await ScheduleWakeup.run(call({ ...VALID, noop: "yes" }), ctx);
    expect(badNoop.content).toBe("`noop` must be a boolean");
    expect(wakeups()).toEqual([]);
  });

  it("ends a loop that reached its maximum age", async () => {
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      setSystemTime(new Date(FIXED_NOW.getTime() + hour * 3_600_000));
      await ScheduleWakeup.run(call({ ...VALID, delaySeconds: 3600 }), ctx);
    }
    setSystemTime(new Date(FIXED_NOW.getTime() + 7 * 24 * 3_600_000));
    const result = await ScheduleWakeup.run(call({ ...VALID, delaySeconds: 3600 }), ctx);
    expect(result.content).toBe(
      "Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue. Then write the loop's outcome for the user as ordinary visible response text — and end the turn.",
    );
    expect(wakeups()).toEqual([]);
  });
});
