import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";
import { restoreSessionTasks } from "@/engine/background/cron/restore.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";

const CREATED = "2026-01-15T12:00:10.000Z";
const createdMs = Date.parse(CREATED);
const DAY_MS = 24 * 60 * 60 * 1000;

let project: string;

function created(
  callId: string,
  id: string,
  input: { cron: string; prompt: string },
  flags: { recurring?: boolean; durable?: boolean; isError?: boolean } = {},
): SessionRecord[] {
  return [
    { type: "tool_call", ts: CREATED, tool_name: "CronCreate", call_id: callId, args: input },
    {
      type: "tool_result",
      ts: CREATED,
      call_id: callId,
      result: `Scheduled job ${id}.`,
      is_error: flags.isError ?? false,
      meta: {
        kind: "scheduled_task",
        id,
        recurring: flags.recurring ?? true,
        durable: flags.durable ?? false,
      },
    },
  ];
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "schedule-restore-"));
  cron.useProjectRootForTests(project);
});

afterEach(() => {
  cron.useProjectRootForTests(null);
  delete process.env.OTHERSIDE_DISABLE_CRON;
  rmSync(project, { recursive: true, force: true });
});

describe("restoreSessionTasks", () => {
  it("re-arms a session-only task with the id and age it was created with", () => {
    const records = created("c1", "0000abcd", { cron: "*/5 * * * *", prompt: "poll CI" });

    expect(restoreSessionTasks(records, createdMs + DAY_MS)).toBe(1);

    expect(cron.tasks()).toEqual([
      expect.objectContaining({
        id: "0000abcd",
        cron: "*/5 * * * *",
        prompt: "poll CI",
        recurring: true,
        durable: false,
        createdAt: createdMs,
      }),
    ]);
  });

  it("leaves cancelled, durable, failed, expired and already-live tasks alone", () => {
    const records: SessionRecord[] = [
      ...created("c1", "00000001", { cron: "*/5 * * * *", prompt: "cancelled" }),
      {
        type: "tool_call",
        ts: CREATED,
        tool_name: "CronDelete",
        call_id: "d1",
        args: { id: "00000001" },
      },
      ...created("c2", "00000002", { cron: "*/5 * * * *", prompt: "durable" }, { durable: true }),
      ...created("c3", "00000003", { cron: "*/5 * * * *", prompt: "failed" }, { isError: true }),
      ...created("c4", "00000004", { cron: "0 9 * * *", prompt: "done" }, { recurring: false }),
      ...created("c5", "00000005", { cron: "*/5 * * * *", prompt: "live" }),
    ];
    cron.create({ id: "00000005", cron: "*/5 * * * *", prompt: "live" });

    expect(restoreSessionTasks(records, createdMs + DAY_MS)).toBe(0);
    expect(cron.tasks().map((task) => task.prompt)).toEqual(["live"]);
  });

  it("drops a recurring task a week old and keeps a one-shot still to come", () => {
    const records = [
      ...created("c1", "00000001", { cron: "*/5 * * * *", prompt: "aged" }),
      ...created("c2", "00000002", { cron: "0 9 * * *", prompt: "tomorrow" }, { recurring: false }),
    ];
    expect(restoreSessionTasks(records, createdMs + 7 * DAY_MS)).toBe(0);
    expect(restoreSessionTasks(records, createdMs + 60_000)).toBe(2);
  });

  it("restores nothing while scheduling is switched off", () => {
    process.env.OTHERSIDE_DISABLE_CRON = "1";
    const records = created("c1", "0000abcd", { cron: "*/5 * * * *", prompt: "poll CI" });
    expect(restoreSessionTasks(records, createdMs)).toBe(0);
  });
});
