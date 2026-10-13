import { describe, expect, it } from "bun:test";
import type { ScheduledTask } from "@/engine/background/cron/index.ts";
import {
  firstFireMs,
  hasAgedOut,
  missedOneShots,
  nextOneShotFireMs,
  nextRecurringFireMs,
  RECURRING_MAX_AGE_MS,
} from "@/engine/background/cron/timing.ts";

const at = (time: string): number => new Date(`2026-01-15T${time}`).getTime();
// Read as a fraction of the id space: exactly one half.
const HALF = "80000000";

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: HALF,
    cron: "*/10 * * * *",
    prompt: "check the build",
    recurring: true,
    durable: false,
    createdAt: at("12:00:10"),
    lastFiredAt: null,
    ...overrides,
  };
}

describe("recurring fire times", () => {
  it("delays each fire by a share of the gap that the task id fixes", () => {
    expect(nextRecurringFireMs("*/10 * * * *", at("12:00:10"), HALF)).toBe(at("12:12:30"));
    expect(nextRecurringFireMs("*/10 * * * *", at("12:00:10"), "00000000")).toBe(at("12:10:00"));
  });

  it("never delays a fire by more than half an hour", () => {
    expect(nextRecurringFireMs("0 */2 * * *", at("12:00:10"), "ffffffff")).toBe(at("14:30:00"));
  });

  it("lands a five-minute cadence inside the prompt cache instead of just past it", () => {
    expect(nextRecurringFireMs("*/5 * * * *", at("12:00:10"), HALF)).toBe(at("12:04:55"));
    expect(nextRecurringFireMs("*/6 * * * *", at("12:00:10"), "00000000")).toBe(at("12:06:00"));
  });
});

describe("one-shot fire times", () => {
  it("fires a task pinned to a round half hour a little early, never late", () => {
    expect(nextOneShotFireMs("30 14 * * *", at("12:00:00"), HALF)).toBe(at("14:29:15"));
    expect(nextOneShotFireMs("7 14 * * *", at("12:00:00"), HALF)).toBe(at("14:07:00"));
  });

  it("never fires before the task existed", () => {
    expect(nextOneShotFireMs("30 14 * * *", at("14:29:50"), HALF)).toBe(at("14:29:50"));
  });
});

describe("firstFireMs", () => {
  it("anchors a recurring task on its last fire, else on its creation", () => {
    expect(firstFireMs(task({}))).toBe(at("12:12:30"));
    expect(firstFireMs(task({ lastFiredAt: at("12:40:00") }))).toBe(at("12:52:30"));
  });

  it("fires a /loop wakeup at its exact moment", () => {
    expect(firstFireMs(task({ kind: "loop", scheduledFor: at("12:03:00") }))).toBe(at("12:03:00"));
  });
});

describe("hasAgedOut", () => {
  it("retires a recurring task a week after it was created, whatever it fired since", () => {
    const created = at("12:00:10");
    const recurring = task({ createdAt: created, lastFiredAt: created + RECURRING_MAX_AGE_MS });
    expect(hasAgedOut(recurring, created + RECURRING_MAX_AGE_MS - 1)).toBe(false);
    expect(hasAgedOut(recurring, created + RECURRING_MAX_AGE_MS)).toBe(true);
    expect(hasAgedOut(task({ recurring: false }), created + RECURRING_MAX_AGE_MS)).toBe(false);
  });
});

describe("missedOneShots", () => {
  it("names only saved one-shot tasks whose moment passed", () => {
    const createdAt = at("08:00:00");
    const missed = task({ id: "a", cron: "0 9 * * *", recurring: false, durable: true, createdAt });
    const later = task({ id: "b", cron: "0 23 * * *", recurring: false, durable: true, createdAt });
    const sessionOnly = task({ id: "c", cron: "0 9 * * *", recurring: false, createdAt });
    const recurring = task({ id: "d", cron: "0 9 * * *", durable: true, createdAt });
    expect(missedOneShots([missed, later, sessionOnly, recurring], at("12:00:00"))).toEqual([
      missed,
    ]);
  });
});
