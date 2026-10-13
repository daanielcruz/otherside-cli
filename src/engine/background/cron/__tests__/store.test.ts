import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";

let project: string;

function savedFile(): { tasks: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(cron.savedSchedulePath(), "utf8"));
}

function writeSavedFile(tasks: unknown[]): void {
  mkdirSync(dirname(cron.savedSchedulePath()), { recursive: true });
  writeFileSync(cron.savedSchedulePath(), JSON.stringify({ tasks }));
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "schedule-store-"));
  cron.useProjectRootForTests(project);
});

afterEach(() => {
  cron.useProjectRootForTests(null);
  rmSync(project, { recursive: true, force: true });
});

describe("the durable schedule", () => {
  it("saves a durable task in the project, owned by the process that saved it", () => {
    const task = cron.create({ cron: "7 9 * * *", prompt: "morning report", durable: true });

    expect(cron.savedSchedulePath()).toBe(join(project, ".otherside", "scheduled_tasks.json"));
    expect(savedFile().tasks).toEqual([
      {
        id: task.id,
        cron: "7 9 * * *",
        prompt: "morning report",
        createdAt: task.createdAt,
        recurring: true,
        ownerPid: process.pid,
      },
    ]);
    expect(task.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("keeps session-only tasks off disk", () => {
    cron.create({ cron: "*/5 * * * *", prompt: "poll" });
    expect(cron.tasks()).toHaveLength(1);
    expect(() => readFileSync(cron.savedSchedulePath())).toThrow();
  });

  it("sees what another session saved, and keeps it when saving its own", () => {
    writeSavedFile([{ id: "0000beef", cron: "0 9 * * *", prompt: "theirs", createdAt: 1 }]);
    expect(cron.tasks().map((task) => task.prompt)).toEqual(["theirs"]);

    cron.create({ cron: "7 9 * * *", prompt: "mine", durable: true });

    expect(savedFile().tasks.map((task) => task.prompt)).toEqual(["theirs", "mine"]);
  });

  it("drops entries it cannot schedule", () => {
    writeSavedFile([
      { id: "0000beef", cron: "not a cron", prompt: "broken", createdAt: 1 },
      { id: 7, cron: "0 9 * * *", prompt: "bad id", createdAt: 1 },
      { id: "0000cafe", cron: "0 9 * * *", prompt: "good", createdAt: 1 },
    ]);
    expect(cron.tasks().map((task) => task.id)).toEqual(["0000cafe"]);
  });

  it("removes and marks fires in the file", () => {
    const kept = cron.create({ cron: "7 9 * * *", prompt: "kept", durable: true });
    const dropped = cron.create({ cron: "8 9 * * *", prompt: "dropped", durable: true });
    const session = cron.create({ cron: "*/5 * * * *", prompt: "session" });

    cron.markFired(kept.id, 1234);
    expect(cron.removeMany([dropped.id, session.id, "00000000"])).toBe(2);

    expect(savedFile().tasks).toEqual([
      expect.objectContaining({ id: kept.id, lastFiredAt: 1234 }),
    ]);
    expect(cron.get(kept.id)?.lastFiredAt).toBe(1234);
    expect(cron.get(session.id)).toBeUndefined();
  });
});
