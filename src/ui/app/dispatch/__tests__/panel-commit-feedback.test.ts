import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG } from "@/commands/index.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { Session } from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { makeMacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { createApplySlashResult, createRecordPanelCommit } from "@/ui/app/dispatch/slash-result.ts";

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "panel-commit-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

describe("panel commit feedback", () => {
  it("routes a known panel command with feedback into the slash applier", () => {
    const applied: { kind: string; command: string; feedback: string; text: string }[] = [];
    const record = createRecordPanelCommit(async (result, text) => {
      applied.push({
        kind: result.kind,
        command: result.command?.name ?? "",
        feedback: result.feedback ?? "",
        text,
      });
    });

    record("model", "Set model to Opus 5");
    record("effort", "Set effort level to high");
    record("not-a-command", "ignored");
    record("model", "");

    expect(applied).toEqual([
      { kind: "toggle", command: "model", feedback: "Set model to Opus 5", text: "/model" },
      { kind: "toggle", command: "effort", feedback: "Set effort level to high", text: "/effort" },
    ]);
  });

  it("lands as the same muted line and persistence the slash path writes", async () => {
    let entries: readonly TranscriptEntry[] = [];
    const session = new Session("panel-commit-session", base);
    const broker = {
      read: () => ({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        fastMode: false,
        permissionMode: "default",
        orchestrationMode: "disabled",
      }),
    } as unknown as Broker;
    let ids = 0;
    const applySlashResult = createApplySlashResult({
      runSkill: async () => {},
      runningRef: { current: false },
      applyPendingChange: () => {},
      nextTranscriptId: (prefix) => `${prefix}_${++ids}`,
      setTranscript: (value) => {
        entries = typeof value === "function" ? value(entries) : value;
      },
      agent: {} as unknown as Agent,
      runSubmittedTurnRef: { current: async () => {} },
      transcriptBatch: makeMacrotaskBatch(),
      session,
      broker,
    });

    const command = CATALOG.find((c) => c.name === "model");
    if (command === undefined) throw new Error("model command missing from catalog");
    await applySlashResult({ kind: "toggle", command, feedback: "Set model to Opus 5" }, "/model");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "compact_done",
      text: "Set model to Opus 5",
      muted: true,
    });
    // The local command persists to the session exactly like the slash path.
    expect(session.messages).toHaveLength(3);
    const joined = session.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(joined).toContain("<command-name>/model</command-name>");
    expect(joined).toContain("<local-command-stdout>Set model to Opus 5</local-command-stdout>");
  });
});
