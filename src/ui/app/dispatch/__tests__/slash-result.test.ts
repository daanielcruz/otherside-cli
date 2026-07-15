import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import type { PendingChange, SlashResult } from "@/commands/types.ts";
import {
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  findModel,
} from "@/engine/model/catalog.ts";
import { Agent } from "@/engine/queue/index.ts";
import { Session } from "@/engine/session/record/index.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import { Broker } from "@/store/app-store/broker.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import {
  createApplySlashResult,
  createRecordPanelCommit,
  shouldRecordLocalCommand,
} from "@/ui/app/dispatch/slash-result.ts";
import { createQueueHelpers } from "@/ui/app/drain/queue.ts";

function command(name: string): SlashCommand {
  return { name, description: "" } as SlashCommand;
}

function result(partial: Partial<SlashResult> & { kind: SlashResult["kind"] }): SlashResult {
  return { ...partial, kind: partial.kind };
}

describe("shouldRecordLocalCommand", () => {
  it("records direct-set commands that print stdout", () => {
    expect(
      shouldRecordLocalCommand(
        result({ kind: "panel", command: command("effort"), feedback: "Set effort level to high" }),
      ),
    ).toBe(true);
    expect(
      shouldRecordLocalCommand(
        result({ kind: "toggle", command: command("plan"), feedback: "plan mode on" }),
      ),
    ).toBe(true);
    expect(
      shouldRecordLocalCommand(
        result({ kind: "anchor", command: command("goal"), feedback: "Goal set: tests pass" }),
      ),
    ).toBe(true);
    expect(
      shouldRecordLocalCommand(
        result({ kind: "instant", command: command("copy"), feedback: "Copied" }),
      ),
    ).toBe(true);
  });

  it("skips panel-open without stdout", () => {
    expect(shouldRecordLocalCommand(result({ kind: "panel", command: command("effort") }))).toBe(
      false,
    );
  });

  it("skips kinds that become turns or route elsewhere", () => {
    for (const kind of ["skill", "workflow", "unknown", "auth", "external"] as const) {
      expect(
        shouldRecordLocalCommand(result({ kind, command: command("x"), feedback: "out" })),
      ).toBe(false);
    }
  });

  it("skips /clear (records would land in the reset session)", () => {
    expect(
      shouldRecordLocalCommand(
        result({ kind: "anchor", command: command("clear"), feedback: "cleared" }),
      ),
    ).toBe(false);
  });
});

const GOAL_META = "GOAL_META_SENTINEL";

function goalResult(): SlashResult {
  const change: PendingChange = {
    kind: "set_goal",
    condition: "b",
    metaMessage: GOAL_META,
  };
  return result({
    kind: "anchor",
    command: command("goal"),
    feedback: "Goal set: b",
    pendingChange: change,
  });
}

describe("createApplySlashResult — goal routing", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "slash-goal-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function setup(running: boolean) {
    const broker = new Broker(
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        effort: "high",
        fastMode: false,
        permissionMode: "default",
      },
      { findModel, effortLevelsForModel, defaultEffortForModel, defaultModelForProvider },
    );
    const session = new Session("session-goal", base);
    const agent = new Agent({ broker, session, config: DEFAULT_CONFIG, getLastUsage: () => null });
    const helpers = createQueueHelpers({
      pasteStoreRef: { current: createPasteStore("session-goal") },
      session,
      agent,
      broker,
      compactTerminalRef: { current: false },
      runtimeConfigRef: { current: DEFAULT_CONFIG },
    });
    let turnsStarted = 0;
    const handler = createApplySlashResult({
      runSkill: () => {},
      runningRef: { current: running },
      applyPendingChange: helpers.applyPendingChange,
      nextTranscriptId: (p) => `${p}_1`,
      setTranscript: () => {},
      agent,
      runSubmittedTurnRef: {
        current: async () => {
          turnsStarted += 1;
        },
      },
      transcriptBatch: { enqueue: (fn) => fn(), flushNow: () => {} },
      session,
      broker,
    });
    return { agent, handler, turnsStarted: () => turnsStarted };
  }

  it("applies a running-turn goal immediately (injection pushed), no new turn", async () => {
    const { agent, handler, turnsStarted } = setup(true);
    await handler(goalResult(), "/goal b");
    // applyPendingChange pushed the meta onto the injection queue; the buggy
    // enqueue path would leave it empty ([QUEUED] until turn end).
    expect(agent.injections.peek()).toContain(GOAL_META);
    expect(turnsStarted()).toBe(0);
  });

  it("applies an idle goal and starts a turn to pursue it", async () => {
    const { agent, handler, turnsStarted } = setup(false);
    await handler(goalResult(), "/goal b");
    expect(agent.injections.peek()).toContain(GOAL_META);
    expect(turnsStarted()).toBe(1);
  });
});

describe("createRecordPanelCommit", () => {
  it("invokes applySlashResult with toggle kind, catalog entry, and feedback", async () => {
    let invokedResult: SlashResult | null = null;
    let invokedText: string = "";
    const mockApply = async (result: SlashResult, text: string) => {
      invokedResult = result;
      invokedText = text;
    };
    const fn = createRecordPanelCommit(mockApply);
    fn("effort", "Set effort level to high");
    expect(invokedResult).not.toBeNull();
    expect(invokedResult!.kind).toBe("toggle");
    expect(invokedResult!.command!.name).toBe("effort");
    expect(invokedResult!.feedback).toBe("Set effort level to high");
    expect(invokedText).toBe("/effort");
  });

  it("is a no-op for unknown command names", async () => {
    let invoked = false;
    const mockApply = async () => {
      invoked = true;
    };
    const fn = createRecordPanelCommit(mockApply);
    fn("unknown_command_name_xyz", "some feedback");
    expect(invoked).toBe(false);
  });
});
