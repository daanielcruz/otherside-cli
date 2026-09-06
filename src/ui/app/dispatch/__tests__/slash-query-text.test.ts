import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@/commands/index.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { Session } from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { makeMacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { createApplySlashResult } from "@/ui/app/dispatch/slash-result.ts";

interface Submission {
  text: string;
  suppressed: boolean;
}

interface SkillRun {
  name: string;
  args: string;
  raw: string;
}

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "slash-query-text-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function applier(running: boolean, submissions: Submission[], skillRuns: SkillRun[] = []) {
  let entries: readonly TranscriptEntry[] = [];
  let ids = 0;
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
  return createApplySlashResult({
    runSkill: async (name, args, raw) => {
      skillRuns.push({ name, args, raw });
    },
    runningRef: { current: running },
    applyPendingChange: () => {},
    nextTranscriptId: (prefix) => `${prefix}_${++ids}`,
    setTranscript: (value) => {
      entries = typeof value === "function" ? value(entries) : value;
    },
    agent: {} as unknown as Agent,
    runSubmittedTurnRef: {
      current: async (text, opts) => {
        submissions.push({ text, suppressed: opts?.suppressUserTranscript === true });
      },
    },
    transcriptBatch: makeMacrotaskBatch(),
    session: new Session("slash-query-text-session", base),
    broker,
  });
}

describe("what a submitting command actually sends", () => {
  test("sends the words it resolved rather than the line that was typed", async () => {
    const submissions: Submission[] = [];
    const apply = applier(false, submissions);

    await apply(
      { kind: "instant", shouldQuery: true, queryText: "Summarize the release notes." },
      "/notes:summarize release notes",
    );

    expect(submissions).toEqual([{ text: "Summarize the release notes.", suppressed: false }]);
  });

  test("shows those words, since what goes out under the reader's name is readable back", async () => {
    const submissions: Submission[] = [];
    const apply = applier(false, submissions);

    await apply({ kind: "instant", shouldQuery: true, queryText: "Do the thing." }, "/some:prompt");

    expect(submissions[0]?.suppressed).toBe(false);
  });

  test("falls back to the typed line when nothing replaced it, and does not echo it twice", async () => {
    const submissions: Submission[] = [];
    const apply = applier(false, submissions);

    await apply({ kind: "unknown", shouldQuery: true }, "/Users/someone/notes.txt");

    expect(submissions).toEqual([{ text: "/Users/someone/notes.txt", suppressed: true }]);
  });

  test("sends nothing while a turn is live, so a resolved prompt cannot cut in", async () => {
    const submissions: Submission[] = [];
    const apply = applier(true, submissions);

    await apply({ kind: "instant", shouldQuery: true, queryText: "Would have been sent." }, "/x:y");

    expect(submissions).toEqual([]);
  });
});

describe("who runs a command that stands in for a prompt", () => {
  const skillCommand = { name: "dream", kind: "skill", description: "" } as const;
  const workflowCommand = { name: "ultraplan", kind: "workflow", description: "" } as const;

  test("hands a skill to the runner, which alone knows whether it forks", async () => {
    const submissions: Submission[] = [];
    const skillRuns: SkillRun[] = [];
    const apply = applier(false, submissions, skillRuns);

    await apply(
      { kind: "skill", command: skillCommand as unknown as SlashCommand },
      "/dream the last week",
    );

    expect(skillRuns).toEqual([
      { name: "dream", args: "the last week", raw: "/dream the last week" },
    ]);
    // A main turn here is the bug: it would run the skill's body inline and
    // never read its `context: fork` declaration.
    expect(submissions).toEqual([]);
  });

  test("hands a workflow command over the same way", async () => {
    const submissions: Submission[] = [];
    const skillRuns: SkillRun[] = [];
    const apply = applier(false, submissions, skillRuns);

    await apply(
      { kind: "workflow", command: workflowCommand as unknown as SlashCommand },
      "/ultraplan the migration",
    );

    expect(skillRuns).toEqual([
      { name: "ultraplan", args: "the migration", raw: "/ultraplan the migration" },
    ]);
    expect(submissions).toEqual([]);
  });

  test("reads the arguments off an alias too, where the name is not in the line", async () => {
    const submissions: Submission[] = [];
    const skillRuns: SkillRun[] = [];
    const apply = applier(false, submissions, skillRuns);

    await apply(
      { kind: "skill", command: skillCommand as unknown as SlashCommand },
      "/learn today",
    );

    expect(skillRuns[0]?.args).toBe("today");
  });
});
