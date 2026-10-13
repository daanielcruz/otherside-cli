import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";
import {
  beginLoopTick,
  endDynamicLoop,
  hasPendingLoopWakeup,
  noteLoopWakeupFired,
  resetLoopRuntimeForTests,
  scheduleLoopWakeup,
  settleLoopTick,
} from "@/engine/background/loop/dynamic.ts";

const PROMPT = "/loop check the deploy";
const at = (time: string): number => new Date(`2026-01-15T${time}`).getTime();

let project: string;

function pending(): cron.ScheduledTask[] {
  return cron.tasks().filter((task) => task.kind === "loop");
}

/** A wakeup fires and its tick runs to the end of the turn. */
function runTick(): void {
  noteLoopWakeupFired(PROMPT);
  cron.removeMany(pending().map((task) => task.id));
  beginLoopTick();
  settleLoopTick();
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "loop-runtime-"));
  cron.useProjectRootForTests(project);
  resetLoopRuntimeForTests();
  setSystemTime(new Date(at("12:00:10")));
});

afterEach(() => {
  setSystemTime();
  resetLoopRuntimeForTests();
  cron.useProjectRootForTests(null);
  rmSync(project, { recursive: true, force: true });
});

describe("scheduleLoopWakeup", () => {
  it("fires on a whole minute and replaces the pending wakeup", () => {
    scheduleLoopWakeup(600, PROMPT, { reason: "quiet" });
    const second = scheduleLoopWakeup(900, PROMPT, { reason: "quieter" });

    expect(second?.scheduledFor).toBe(at("12:16:00"));
    expect(pending()).toEqual([
      expect.objectContaining({ prompt: PROMPT, reason: "quieter", scheduledFor: at("12:16:00") }),
    ]);
  });

  it("pulls a short delay back so the fire still reads the cached prompt", () => {
    expect(scheduleLoopWakeup(290, PROMPT)?.scheduledFor).toBe(at("12:04:00"));
    expect(scheduleLoopWakeup(150, PROMPT)?.scheduledFor).toBe(at("12:03:00"));
    expect(scheduleLoopWakeup(600, PROMPT)?.scheduledFor).toBe(at("12:11:00"));
  });

  it("clamps the delay to between a minute and an hour", () => {
    expect(scheduleLoopWakeup(1, PROMPT)).toEqual(
      expect.objectContaining({ clampedDelaySeconds: 60, wasClamped: true }),
    );
    expect(scheduleLoopWakeup(86_400, PROMPT)).toEqual(
      expect.objectContaining({ clampedDelaySeconds: 3600, wasClamped: true }),
    );
  });

  it("ends a loop that has run for a week instead of re-arming it", () => {
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      setSystemTime(new Date(at("12:00:10") + hour * 3_600_000));
      expect(scheduleLoopWakeup(3600, PROMPT)).not.toBeNull();
    }
    setSystemTime(new Date(at("12:00:10") + 7 * 24 * 3_600_000));
    expect(scheduleLoopWakeup(3600, PROMPT)).toBeNull();
    expect(hasPendingLoopWakeup()).toBe(false);
  });
});

describe("a tick that schedules no next wakeup", () => {
  it("gets one fallback wakeup, and the loop ends after a second such tick", () => {
    scheduleLoopWakeup(600, PROMPT);
    runTick();
    expect(pending()).toEqual([
      expect.objectContaining({ prompt: PROMPT, keepalive: true, scheduledFor: at("12:21:00") }),
    ]);

    runTick();
    expect(hasPendingLoopWakeup()).toBe(false);
  });

  it("earns a new fallback once the model schedules again", () => {
    scheduleLoopWakeup(600, PROMPT);
    runTick();
    noteLoopWakeupFired(PROMPT);
    beginLoopTick();
    scheduleLoopWakeup(600, PROMPT);
    settleLoopTick();
    runTick();
    expect(pending()).toEqual([expect.objectContaining({ keepalive: true })]);
  });

  it("leaves turns that ran no tick alone", () => {
    settleLoopTick();
    expect(hasPendingLoopWakeup()).toBe(false);
  });
});

describe("endDynamicLoop", () => {
  it("cancels the pending wakeup and keeps the ended tick from re-arming", () => {
    scheduleLoopWakeup(600, PROMPT);
    noteLoopWakeupFired(PROMPT);
    cron.removeMany(pending().map((task) => task.id));
    beginLoopTick();
    expect(endDynamicLoop()).toBe(0);
    settleLoopTick();
    expect(hasPendingLoopWakeup()).toBe(false);

    scheduleLoopWakeup(600, PROMPT);
    expect(endDynamicLoop()).toBe(1);
    expect(hasPendingLoopWakeup()).toBe(false);
  });
});
