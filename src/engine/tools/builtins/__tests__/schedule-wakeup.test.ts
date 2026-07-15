import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as cron from "@/engine/background/cron/index.ts";
import { _testTick } from "@/engine/background/cron/scheduler.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  _resetScheduleWakeupForTests,
  ScheduleWakeup,
} from "@/engine/tools/builtins/schedule-wakeup.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const FIXED_NOW = new Date("2026-01-15T12:00:10");
const ctx = {} as RequestContext;

function call(input: Record<string, unknown>, id = "wake-1"): ToolCall {
  return { id, name: "ScheduleWakeup", input };
}

describe("ScheduleWakeup", () => {
  beforeEach(() => {
    setSystemTime(FIXED_NOW);
    cron.clear();
    emitQueue._resetForTests();
    _resetScheduleWakeupForTests();
  });

  afterEach(() => {
    setSystemTime();
    cron.clear();
    emitQueue._resetForTests();
    _resetScheduleWakeupForTests();
  });

  it("clamps the delay and replaces an existing loop wakeup", async () => {
    const first = await ScheduleWakeup.run(
      call({ delaySeconds: 1, reason: "keep the loop alive", prompt: "check build" }),
      ctx,
    );

    expect(first.is_error).toBeUndefined();
    expect(first.content).toContain("(clamped to 60s from your requested value)");
    expect(cron.list()).toEqual([
      expect.objectContaining({
        prompt: "check build",
        durable: false,
        kind: "loop",
        scheduledFor: new Date("2026-01-15T12:02:00").getTime(),
      }),
    ]);

    await ScheduleWakeup.run(
      call(
        { delaySeconds: 120, reason: "check after the next build step", prompt: "check again" },
        "wake-2",
      ),
      ctx,
    );

    expect(cron.list()).toEqual([
      expect.objectContaining({
        prompt: "check again",
        kind: "loop",
        scheduledFor: new Date("2026-01-15T12:03:00").getTime(),
      }),
    ]);
  });

  it("resumes through the auto-turn queue at the scheduled time", async () => {
    await ScheduleWakeup.run(
      call({ delaySeconds: 120, reason: "wait for state to change", prompt: "inspect state" }),
      ctx,
    );
    const injections: string[] = [];
    const sink = { pushInjection: (text: string) => injections.push(text) };

    setSystemTime(new Date("2026-01-15T12:02:59"));
    _testTick(sink);
    expect(emitQueue.hasPendingAutoTurn()).toBe(false);
    expect(cron.list()).toHaveLength(1);

    setSystemTime(new Date("2026-01-15T12:03:00"));
    _testTick(sink);

    expect(injections).toEqual([]);
    expect(cron.list()).toEqual([]);
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
    expect(emitQueue.peek()).toEqual([
      expect.objectContaining({
        class: "urgent_output",
        target: "both",
        payload: { kind: "user_interrupt_message", text: "inspect state" },
        autoTurn: true,
      }),
    ]);
  });
});
