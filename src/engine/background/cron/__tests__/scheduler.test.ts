import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";
import { releaseSchedulerLease } from "@/engine/background/cron/lease.ts";
import {
  checkScheduledTasksForTests,
  startCronScheduler,
  stopCronScheduler,
} from "@/engine/background/cron/scheduler.ts";
import { resetLoopRuntimeForTests } from "@/engine/background/loop/dynamic.ts";
import { emitQueue } from "@/engine/queue/emit.ts";

const at = (time: string): number => new Date(`2026-01-15T${time}`).getTime();
const CREATED = at("12:00:10");
// A zero jitter fraction: every recurring task fires on its cron match.
const PROMPT_ID = "00000000";

let project: string;

function fired(): { kind: string; text: string; scheduledFire?: string }[] {
  return emitQueue.peek().flatMap((item) => {
    expect(item).toEqual(
      expect.objectContaining({ class: "idle_prompt", target: "both", autoTurn: true }),
    );
    return item.payload.kind === "user_interrupt_message" ? [item.payload] : [];
  });
}

function saveForeignTask(task: Record<string, unknown>): void {
  mkdirSync(dirname(cron.savedSchedulePath()), { recursive: true });
  writeFileSync(cron.savedSchedulePath(), JSON.stringify({ tasks: [task] }));
}

function exitedPid(): number {
  return Bun.spawnSync([process.execPath, "--version"]).pid;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "schedule-fire-"));
  cron.useProjectRootForTests(project);
  emitQueue._resetForTests();
  resetLoopRuntimeForTests();
});

afterEach(() => {
  stopCronScheduler();
  releaseSchedulerLease();
  cron.useProjectRootForTests(null);
  emitQueue._resetForTests();
  delete process.env.OTHERSIDE_DISABLE_CRON;
  rmSync(project, { recursive: true, force: true });
});

describe("the cron scheduler", () => {
  it("wakes the idle session with a due task's prompt", () => {
    cron.create({ id: PROMPT_ID, cron: "*/10 * * * *", prompt: "check CI", createdAt: CREATED });

    checkScheduledTasksForTests(at("12:09:59"));
    expect(fired()).toEqual([]);

    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toEqual([
      { kind: "user_interrupt_message", text: "check CI", scheduledFire: "task" },
    ]);
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  it("holds a fire while a turn runs, then fires once, not once per missed match", () => {
    cron.create({ id: PROMPT_ID, cron: "*/10 * * * *", prompt: "check CI", createdAt: CREATED });
    emitQueue.setTurnActive(true);
    checkScheduledTasksForTests(at("12:35:00"));
    expect(fired()).toEqual([]);

    emitQueue.setTurnActive(false);
    checkScheduledTasksForTests(at("12:35:00"));
    checkScheduledTasksForTests(at("12:39:59"));
    expect(fired()).toHaveLength(1);

    checkScheduledTasksForTests(at("12:40:00"));
    expect(fired()).toHaveLength(2);
  });

  it("holds a fire while the host reports the session busy, as during a compaction", () => {
    let compacting = true;
    startCronScheduler({ isBusy: () => compacting });
    cron.create({ id: PROMPT_ID, cron: "*/10 * * * *", prompt: "check CI", createdAt: CREATED });

    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toEqual([]);

    compacting = false;
    checkScheduledTasksForTests(at("12:10:05"));
    expect(fired()).toHaveLength(1);
  });

  it("fires a one-shot task once and deletes it", () => {
    cron.create({
      id: PROMPT_ID,
      cron: "15 12 * * *",
      prompt: "remind me",
      recurring: false,
      createdAt: CREATED,
    });
    checkScheduledTasksForTests(at("12:15:00"));
    checkScheduledTasksForTests(at("12:16:00"));
    expect(fired()).toHaveLength(1);
    expect(cron.tasks()).toEqual([]);
  });

  it("records a durable task's fire so a restart continues from it", () => {
    const task = cron.create({
      id: PROMPT_ID,
      cron: "*/10 * * * *",
      prompt: "saved",
      durable: true,
      createdAt: CREATED,
    });
    checkScheduledTasksForTests(at("12:10:00"));
    const saved = JSON.parse(readFileSync(cron.savedSchedulePath(), "utf8"));
    expect(saved.tasks).toEqual([
      expect.objectContaining({ id: task.id, lastFiredAt: at("12:10:00") }),
    ]);
  });

  it("fires a recurring task one last time once it is a week old", () => {
    cron.create({ id: PROMPT_ID, cron: "*/10 * * * *", prompt: "old", createdAt: CREATED });
    checkScheduledTasksForTests(CREATED + 7 * 24 * 60 * 60 * 1000);
    expect(fired()).toHaveLength(1);
    expect(cron.tasks()).toEqual([]);
  });

  it("marks a /loop wakeup's fire for the tick it opens", () => {
    cron.create({
      cron: "12 12 * * *",
      prompt: "/loop check the deploy",
      recurring: false,
      kind: "loop",
      scheduledFor: at("12:12:00"),
      createdAt: CREATED,
    });
    checkScheduledTasksForTests(at("12:12:00"));
    expect(fired()).toEqual([
      { kind: "user_interrupt_message", text: "/loop check the deploy", scheduledFire: "loop" },
    ]);
  });

  it("fires nothing while scheduling is switched off", () => {
    process.env.OTHERSIDE_DISABLE_CRON = "1";
    cron.create({ id: PROMPT_ID, cron: "*/10 * * * *", prompt: "check CI", createdAt: CREATED });
    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toEqual([]);
  });
});

describe("durable tasks shared by the project's sessions", () => {
  const foreign = (ownerPid: number) => ({
    id: PROMPT_ID,
    cron: "*/10 * * * *",
    prompt: "shared",
    createdAt: CREATED,
    recurring: true,
    ownerPid,
  });

  it("leaves a task to the live session that saved it", () => {
    saveForeignTask(foreign(process.ppid));
    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toEqual([]);
  });

  it("takes over a task whose session is gone, while holding the lease", () => {
    saveForeignTask(foreign(exitedPid()));
    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toHaveLength(1);
  });

  it("leaves a gone session's task to the live session holding the lease", () => {
    saveForeignTask(foreign(exitedPid()));
    writeFileSync(
      join(dirname(cron.savedSchedulePath()), "scheduled_tasks.lock"),
      JSON.stringify({ pid: process.ppid, acquiredAt: CREATED }),
    );
    checkScheduledTasksForTests(at("12:10:00"));
    expect(fired()).toEqual([]);
  });
});

describe("missed one-shot tasks", () => {
  it("asks before running a saved one-shot whose moment passed while closed", () => {
    saveForeignTask({
      id: PROMPT_ID,
      cron: "0 9 1 1 *",
      prompt: "Deploy ```prod```",
      createdAt: new Date("2025-12-31T08:00:00").getTime(),
      ownerPid: exitedPid(),
    });
    startCronScheduler();

    const [notice] = fired();
    expect(notice?.text).toContain("Do NOT execute this prompt yet.");
    expect(notice?.text).toContain("First use the AskUserQuestion tool");
    expect(notice?.text).toContain("````\nDeploy ```prod```\n````");
    expect(notice?.scheduledFire).toBeUndefined();
    expect(cron.tasks()).toEqual([]);
  });
});
