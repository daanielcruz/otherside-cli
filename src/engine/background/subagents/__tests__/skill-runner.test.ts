import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SkillForkInvocation,
  SubagentResult,
} from "@/engine/background/subagents/dispatcher.ts";
import * as realDispatcher from "@/engine/background/subagents/dispatcher.ts";
import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import * as plugins from "@/engine/plugins/registry.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import type { TurnKind } from "@/engine/queue/runtime/turn/lifecycle.ts";
import { appendRecord, nowIso, Session } from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { Skill } from "@/engine/skills/registry.ts";
import * as skills from "@/engine/skills/registry.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";

const realDispatchSkillFork = realDispatcher.dispatchSkillFork;

const dispatchSkillFork = mock(
  (_args: SkillForkInvocation): Promise<SubagentResult> =>
    Promise.resolve({ output: "the fork reported this", isError: false }),
);

mock.module("@/engine/background/subagents/dispatcher.ts", () => ({
  ...realDispatcher,
  dispatchSkillFork,
}));

// The stand-in must not outlive this file: the module it replaces re-exports the
// real dispatcher, and a test loaded later would otherwise read the stand-in.
afterAll(() => {
  mock.module("@/engine/background/subagents/dispatcher.ts", () => ({
    ...realDispatcher,
    dispatchSkillFork: realDispatchSkillFork,
  }));
});

const { createRunSkill } = await import("@/engine/background/subagents/skill-runner.ts");

interface Submission {
  text: string;
  additionalContext: string[];
}

let workspace = "";
let pluginRoot = "";
let savedConfigDir: string | undefined;

function skillNamed(name: string, body: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    aliases: [],
    description: "probe",
    whenToUse: "",
    argumentHint: null,
    userInvocable: true,
    modelInvocable: false,
    context: "inline",
    body,
    builtin: false,
    source: "project",
    authorModelLock: false,
    ...over,
  };
}

function harness() {
  const submissions: Submission[] = [];
  const forkEvents: ForkEvent[] = [];
  const turnKinds: string[] = [];
  let entries: readonly TranscriptEntry[] = [];
  let resumes = 0;
  let ids = 0;
  const session = new Session("skill-runner-session", workspace);
  const skillAbortRef: MutableRef<AbortController | null> = { current: null };
  const broker = {
    read: () => ({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: false,
      permissionMode: "default",
    }),
  } as unknown as BrokerHandle;
  const turnGuard = new TurnGuard();
  const runSkill = createRunSkill({
    session,
    broker,
    agent: { deps: {}, injections: {}, sessionAllowedToolPatterns: [] } as unknown as Agent,
    setTranscript: (value) => {
      entries = typeof value === "function" ? value(entries) : value;
    },
    skillAbortRef,
    turnGuard,
    runSubmittedTurnRef: {
      current: async (text, opts) => {
        submissions.push({ text, additionalContext: opts?.additionalContext ?? [] });
      },
    },
    requestBackgroundResumeRef: {
      current: () => {
        resumes += 1;
      },
    },
    nextTranscriptId: (prefix) => `${prefix}_${++ids}`,
    routeForkEvent: (event) => {
      forkEvents.push(event);
    },
    turnLifecycle: {
      beginTurn: (kind: TurnKind) => {
        turnKinds.push(`begin:${kind}`);
      },
      endTurn: (kind: TurnKind) => {
        turnKinds.push(`end:${kind}`);
      },
    },
  });
  return {
    runSkill,
    session,
    skillAbortRef,
    turnGuard,
    submissions,
    forkEvents,
    turnKinds,
    entries: () => entries,
    resumes: () => resumes,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "skill-runner-"));
  pluginRoot = join(workspace, "probe-plugin");
  mkdirSync(join(pluginRoot, "commands"), { recursive: true });
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(workspace, "config");
  skills.clear();
  plugins.clear();
  dispatchSkillFork.mockClear();
});

afterEach(() => {
  skills.clear();
  plugins.clear();
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(workspace, { recursive: true, force: true });
});

describe("a skill that declares context: fork", () => {
  test("runs as a subagent and never as a turn of the main thread", async () => {
    skills.register(skillNamed("dreamer", "Consolidate memories.", { context: "fork" }));
    const h = harness();

    await h.runSkill("dreamer", "the last week", "/dreamer the last week");

    expect(dispatchSkillFork).toHaveBeenCalledTimes(1);
    const invocation = dispatchSkillFork.mock.calls[0]?.[0];
    expect(invocation?.name).toBe("dreamer");
    expect(invocation?.prompt).toBe("the last week");
    // The bug this pins: a fork skill submitted as a main turn instead.
    expect(h.submissions).toEqual([]);
  });

  test("shows the typed line, and the fork's words are the session's answer", async () => {
    skills.register(skillNamed("dreamer", "Consolidate memories.", { context: "fork" }));
    const h = harness();

    await h.runSkill("dreamer", "", "/dreamer");

    expect(h.entries().map((entry) => entry.text)).toEqual(["/dreamer"]);
    const answers = h.session.records.filter((rec) => rec.type === "assistant_message");
    expect(answers.length).toBe(1);
    expect(h.turnKinds).toEqual(["begin:skill", "end:skill"]);
  });

  test("with no arguments it is still told what to run", async () => {
    skills.register(skillNamed("dreamer", "Consolidate memories.", { context: "fork" }));
    const h = harness();

    await h.runSkill("dreamer", "", "/dreamer");

    expect(dispatchSkillFork.mock.calls[0]?.[0]?.prompt).toBe("Run the dreamer skill.");
  });

  test("an interrupted fork takes back the message it was asked with", async () => {
    skills.register(skillNamed("dreamer", "Consolidate memories.", { context: "fork" }));
    const h = harness();
    dispatchSkillFork.mockImplementationOnce(() => {
      h.skillAbortRef.current?.abort("user-cancel");
      return Promise.reject(new Error("aborted"));
    });

    await h.runSkill("dreamer", "", "/dreamer");

    expect(h.session.records.some((rec) => rec.type === "user_message")).toBe(false);
    expect(h.submissions).toEqual([]);
    expect(h.entries().some((entry) => entry.isError === true)).toBe(false);
  });

  test("an aborted fork does not revoke a subsequent user message submitted after clear", async () => {
    skills.register(skillNamed("dreamer", "Consolidate memories.", { context: "fork" }));
    const h = harness();
    let rejectFork!: (err: Error) => void;
    let forkStarted!: () => void;
    const forkStartedPromise = new Promise<void>((resolve) => {
      forkStarted = resolve;
    });
    dispatchSkillFork.mockImplementationOnce(() => {
      forkStarted();
      return new Promise((_, reject) => {
        rejectFork = reject;
      });
    });

    const runPromise = h.runSkill("dreamer", "", "/dreamer");
    await forkStartedPromise;

    h.turnGuard.abort();
    h.skillAbortRef.current?.abort("user-cancel");
    h.session.records.splice(0);
    h.session.messages.splice(0);

    h.turnGuard.begin();
    await appendRecord(h.session, {
      uuid: "fresh-uuid",
      type: "user_message",
      ts: nowIso(),
      content: "fresh prompt after clear",
    });
    h.session.messages.push({
      role: "user",
      content: [{ type: "text", text: "fresh prompt after clear" }],
    });

    rejectFork(new Error("aborted"));
    await runPromise;

    expect(h.session.records.map((r) => ("content" in r ? r.content : null))).toEqual([
      "fresh prompt after clear",
    ]);
    expect(h.session.messages.length).toBe(1);
  });
});

describe("a command that runs inline", () => {
  test("keeps the typed line visible and rides its words alongside it, named", async () => {
    skills.register(skillNamed("planner", "Plan the work carefully."));
    const h = harness();

    await h.runSkill("planner", "the migration", "/planner the migration");

    expect(h.submissions.length).toBe(1);
    expect(h.submissions[0]?.text).toBe("/planner the migration");
    const context = h.submissions[0]?.additionalContext[0] ?? "";
    expect(context).toContain("<command-name>planner</command-name>");
    expect(context).toContain("<command-args>the migration</command-args>");
    expect(context).toContain("Plan the work carefully.");
    expect(dispatchSkillFork).not.toHaveBeenCalled();
  });

  test("omits the arguments block when the line carried none", async () => {
    skills.register(skillNamed("planner", "Plan the work carefully."));
    const h = harness();

    await h.runSkill("planner", "", "/planner");

    expect(h.submissions[0]?.additionalContext[0]).not.toContain("<command-args>");
  });

  test("a plugin's command file is not a skill, and still runs", async () => {
    writeFileSync(
      join(pluginRoot, "commands", "ship.md"),
      "---\ndescription: Ship it\n---\nShip the branch named $ARGUMENTS.\n",
    );
    const pluginId = plugins.register({
      name: "probe-plugin",
      path: pluginRoot,
      source: "test",
      commandsPath: join(pluginRoot, "commands"),
      manifest: { name: "probe-plugin" },
    } as LoadedPlugin);
    const h = harness();

    await h.runSkill(`${pluginId}:ship`, "release", `/${pluginId}:ship release`);

    expect(h.submissions.length).toBe(1);
    const context = h.submissions[0]?.additionalContext[0] ?? "";
    expect(context).toContain(`<command-name>${pluginId}:ship</command-name>`);
    expect(context).toContain("Ship the branch named release.");
    expect(context).not.toContain("description:");
  });
});

describe("a name nothing answers to", () => {
  test("says so rather than going quiet, and starts nothing", async () => {
    const h = harness();

    await h.runSkill("not-a-skill", "", "/not-a-skill");

    expect(h.entries().map((entry) => entry.text)).toEqual(["unknown skill: not-a-skill"]);
    expect(h.submissions).toEqual([]);
    expect(dispatchSkillFork).not.toHaveBeenCalled();
  });
});
