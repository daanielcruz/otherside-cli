import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SlashCommand } from "@/commands/catalog.ts";
import { handleGoal } from "@/commands/handlers/goal.ts";
import type { SlashContext } from "@/commands/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { goalAfterTurn } from "@/engine/queue/runtime/goal-after-turn.ts";
import { evaluateGoal } from "@/engine/queue/runtime/goal-evaluation.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { TurnEnding } from "@/engine/queue/runtime/turn/turn-ending.ts";
import {
  _resetGoalsForTesting,
  getActiveGoal,
  restoreGoalFromRecords,
  setActiveGoal,
} from "@/engine/queue/state.ts";
import { enqueueWrite } from "@/engine/session/infra.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import type { SessionRecord } from "@/engine/session/record/schema.ts";
import { Session } from "@/engine/session/record/state.ts";
import { scriptedProvider, turnHost } from "./turn-fixture.ts";

const CONDITION = "all tests pass";
const CMD: SlashCommand = { name: "goal", kind: "instant", description: "Set a goal" };

function newSession(): Session {
  return new Session(`goal-persistence-${crypto.randomUUID()}`, process.cwd());
}

async function persisted(session: Session): Promise<SessionRecord[]> {
  const path = sessionPathForCwd(session.storageCwd, session.id);
  // The runtime appends asynchronously; wait behind all queued writes before reading disk.
  await enqueueWrite(path, async () => {});
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function statuses(records: SessionRecord[]) {
  return records.flatMap((record) =>
    record.type === "attachment" && record.attachment.type === "goal_status"
      ? [record.attachment]
      : [],
  );
}

afterEach(() => {
  _resetGoalsForTesting();
  registerAllProviders();
});

describe("durable goal lifecycle", () => {
  const failures: Array<[TurnEnding, string]> = [
    [{ reason: "request_failed", failure: "auth" }, "authentication failed"],
    [{ reason: "request_failed", failure: "verification" }, "organization verification required"],
    [{ reason: "request_failed", failure: "billing" }, "credit balance too low"],
    [{ reason: "request_failed", failure: "model_unavailable" }, "model unavailable"],
    [{ reason: "request_failed", failure: "context_full" }, "context limit reached"],
    [{ reason: "context_full" }, "context limit reached"],
  ];

  for (const [ending, reason] of failures) {
    test(`persists an unmet failure: ${JSON.stringify(ending)}`, async () => {
      const session = newSession();
      const ctx = { session } as SlashContext;
      await handleGoal(CMD, CONDITION, ctx);
      expect([...goalAfterTurn(session, ending)]).toHaveLength(1);
      expect(getActiveGoal(session.id)).toBeUndefined();
      const records = await persisted(session);
      expect(statuses(records)).toEqual([
        { type: "goal_status", condition: CONDITION, sentinel: true, met: false },
        {
          type: "goal_status",
          condition: CONDITION,
          sentinel: true,
          met: false,
          failed: true,
          reason,
        },
      ]);
      expect(restoreGoalFromRecords(session.id, records)).toBeUndefined();
    });
  }

  for (const keyword of ["clear", "stop", "off", "reset", "none", "cancel"]) {
    test(`persists manual cancellation via /goal ${keyword}`, async () => {
      const session = newSession();
      const ctx = { session } as SlashContext;
      await handleGoal(CMD, CONDITION, ctx);
      const activeRecords = await persisted(session);
      expect(restoreGoalFromRecords(session.id, activeRecords)?.condition).toBe(CONDITION);
      await handleGoal(CMD, keyword, ctx);
      const records = await persisted(session);
      expect(statuses(records).at(-1)).toEqual({
        type: "goal_status",
        condition: CONDITION,
        sentinel: true,
        met: false,
        cleared: true,
      });
      expect(restoreGoalFromRecords(session.id, records)).toBeUndefined();
      await handleGoal(CMD, keyword, ctx);
      await handleGoal(CMD, "", ctx);
      expect(statuses(await persisted(session))).toHaveLength(2);
      await handleGoal(CMD, CONDITION, ctx);
      expect(restoreGoalFromRecords(session.id, await persisted(session))?.condition).toBe(
        CONDITION,
      );
    });
  }

  test("persists fulfillment only after a successful verdict", async () => {
    registerAllProviders();
    providers.register(scriptedProvider(['{"ok":true,"reason":"all tests pass"}']).provider);
    const session = newSession();
    await handleGoal(CMD, CONDITION, { session } as SlashContext);
    const host = turnHost(session.id);
    host.deps.session = session;
    const generator = evaluateGoal({
      session,
      config: host.deps.config,
      ctx: makeRequestContext(host.deps),
      cancelled: () => false,
    });
    let result = await generator.next();
    while (!result.done) result = await generator.next();
    expect(result.value?.outcome).toBe("met");
    const records = await persisted(session);
    expect(statuses(records).at(-1)).toEqual({
      type: "goal_status",
      condition: CONDITION,
      sentinel: true,
      met: true,
      iteration: 1,
    });
    expect(restoreGoalFromRecords(session.id, records)).toBeUndefined();
  });

  test("still accepts legacy met-only terminal records", () => {
    const session = newSession();
    setActiveGoal(session.id, CONDITION);
    expect(
      restoreGoalFromRecords(session.id, [
        {
          type: "attachment",
          ts: new Date().toISOString(),
          attachment: { type: "goal_status", condition: CONDITION, sentinel: true, met: true },
        },
      ]),
    ).toBeUndefined();
  });
});
