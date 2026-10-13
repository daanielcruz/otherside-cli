import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cron from "@/engine/background/cron/index.ts";
import { CronCreate, CronDelete, CronList } from "@/engine/tools/builtins/cron.ts";
import { deferredToolNames } from "@/engine/tools/index.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const ctx = {} as RequestContext;
let project: string;

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, input };
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cron-tools-"));
  cron.useProjectRootForTests(project);
});

afterEach(() => {
  cron.useProjectRootForTests(null);
  delete process.env.OTHERSIDE_DISABLE_CRON;
  rmSync(project, { recursive: true, force: true });
});

describe("CronCreate", () => {
  it("confirms a session-only recurring job and records what a resume needs", async () => {
    const result = await CronCreate.run(
      call("CronCreate", { cron: "*/5 * * * *", prompt: "poll CI" }),
      ctx,
    );
    const [task] = cron.tasks();

    expect(result.content).toBe(
      `Scheduled recurring job ${task?.id} (Every 5 minutes). Session-only (not written to disk, dies when otherside exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`,
    );
    expect(result.meta).toEqual({
      kind: "scheduled_task",
      id: task?.id ?? "",
      recurring: true,
      durable: false,
    });
  });

  it("saves a durable one-shot task in the project", async () => {
    const result = await CronCreate.run(
      call("CronCreate", {
        cron: "7 9 * * *",
        prompt: "remind me",
        recurring: false,
        durable: true,
      }),
      ctx,
    );
    expect(result.content).toMatch(
      /^Scheduled one-shot task [0-9a-f]{8} \(.+\)\. Persisted to \.otherside\/scheduled_tasks\.json\. It will fire once then auto-delete\.$/,
    );
    expect(existsSync(join(project, ".otherside", "scheduled_tasks.json"))).toBe(true);
  });

  it("refuses an expression cron cannot read", async () => {
    const result = await CronCreate.run(call("CronCreate", { cron: "soon", prompt: "x" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe(
      "Invalid cron expression 'soon'. Expected 5 fields: M H DoM Mon DoW.",
    );
  });
});

describe("CronList and CronDelete", () => {
  it("lists each job on one line and cancels by id", async () => {
    expect((await CronList.run(call("CronList", {}), ctx)).content).toBe("No scheduled jobs.");
    const saved = cron.create({ cron: "7 9 * * *", prompt: "morning\nreport", durable: true });
    const session = cron.create({ cron: "*/5 * * * *", prompt: "poll", recurring: false });

    expect((await CronList.run(call("CronList", {}), ctx)).content).toBe(
      [
        `${saved.id} — ${cron.cronToHuman("7 9 * * *")} (recurring): morning report`,
        `${session.id} — Every 5 minutes (one-shot) [session-only]: poll`,
      ].join("\n"),
    );

    const deleted = await CronDelete.run(call("CronDelete", { id: saved.id }), ctx);
    expect(deleted.content).toBe(`Cancelled job ${saved.id}.`);
    const missing = await CronDelete.run(call("CronDelete", { id: saved.id }), ctx);
    expect(missing.is_error).toBe(true);
  });
});

describe("switching scheduling off", () => {
  it("withdraws the cron tools", () => {
    expect(deferredToolNames()).toContain("CronCreate");
    process.env.OTHERSIDE_DISABLE_CRON = "1";
    expect(deferredToolNames()).not.toContain("CronCreate");
    expect(deferredToolNames()).not.toContain("CronList");
    expect(deferredToolNames()).not.toContain("CronDelete");
  });
});
