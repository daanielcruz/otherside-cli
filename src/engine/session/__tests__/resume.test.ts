import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as childProcessModule from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalChildProcess = { ...childProcessModule };
mock.module("node:child_process", () => ({
  ...originalChildProcess,
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(null, "", ""),
}));

import { subscribe as subscribeVisibleTasks } from "@/engine/background/tasks/index.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { appendRecord, loadSessionForResume } from "@/engine/session/persist.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { Session } from "@/engine/session/record/state.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { loadSystemInjectionsForSession } from "@/engine/session/system-injection-store.ts";
import { setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import {
  createResumeSession,
  hydrateSessionFromRecords,
  type ResumeSessionDeps,
  replayInjectionsFromRecords,
} from "../resume.ts";

afterAll(() => {
  mock.module("node:child_process", () => originalChildProcess);
});

// Resuming installs the session's paste store in the process-wide registry, so the
// stand-ins used here must not outlive their test — tools that reach for the store
// would find a stub that answers to none of its methods.
afterEach(() => {
  setActivePasteStore(null);
});

describe("hydrateSessionFromRecords", () => {
  it("hydrates model context independently from full render records", () => {
    const session = new Session("test-session");
    const pasteStoreRef = { current: {} as PasteStore };
    const records: SessionRecord[] = [
      {
        type: "user_message",
        ts: "2026-06-23T00:00:00.000Z",
        content: "visible pre-compact history",
      },
      {
        type: "user_message",
        ts: "2026-06-23T00:00:01.000Z",
        content: "active model context",
      },
    ];

    hydrateSessionFromRecords({
      session,
      id: "test-session",
      records,
      modelRecords: [records[1]!],
      usageRecords: [],
      chainHead: null,
      pasteStoreRef,
      createPasteStore: () => ({}) as PasteStore,
    });

    expect(session.records).toEqual(records);
    expect(JSON.stringify(session.messages)).not.toContain("visible pre-compact history");
    expect(JSON.stringify(session.messages)).toContain("active model context");
  });

  it("restores the tool output archive from records", () => {
    const session = new Session("test-session");
    const pasteStoreRef = { current: {} as PasteStore };
    const mockCreatePasteStore = () => ({}) as PasteStore;

    const records: SessionRecord[] = [
      {
        type: "tool_call",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        tool_name: "Read",
        args: { path: "foo.txt" },
      },
      {
        type: "tool_result",
        ts: "2026-06-23T00:00:00.000Z",
        call_id: "call-1",
        result: "original raw tool result content",
        is_error: false,
      },
      {
        type: "content_replacement",
        ts: "2026-06-23T00:00:00.000Z",
        kind: "tool-result",
        toolUseId: "call-1",
        replacement: "replaced content sentinel",
      },
    ];

    hydrateSessionFromRecords({
      session,
      id: "test-session",
      records,
      usageRecords: [],
      chainHead: null,
      pasteStoreRef,
      createPasteStore: mockCreatePasteStore,
    });

    expect(session.id).toBe("test-session");
    expect(session.toolOutputArchive).toBeDefined();
    expect(session.toolOutputArchive?.notices.get("call-1")).toBe("replaced content sentinel");
  });
});

describe("resume cwd guard", () => {
  let base: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "otherside-resume-cwd-test-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(base, { recursive: true, force: true });
  });

  it("matches canonical paths when the current cwd is a symlink", async () => {
    const persistedCwd = join(base, "repo");
    const linkedCwd = join(base, "repo-link");
    mkdirSync(persistedCwd);
    symlinkSync(persistedCwd, linkedCwd, "dir");
    const persisted = new Session("canonical-resume", persistedCwd);
    await appendRecord(persisted, {
      type: "user_message",
      ts: "2026-06-23T00:00:00.000Z",
      content: "hello",
    });

    const loaded = await loadSessionForResume(persisted.id, linkedCwd);
    expect(loaded.records).toHaveLength(1);
  });

  it("wakes visible-task subscribers after rebinding the resumed session", async () => {
    const persisted = new Session("tasklist-wake-resume", process.cwd());
    await appendRecord(persisted, {
      type: "user_message",
      ts: "2026-06-23T00:00:00.000Z",
      content: "hello",
    });

    let wakes = 0;
    const unsubscribe = subscribeVisibleTasks(() => {
      wakes += 1;
    });
    const noop = (): void => {};
    const current = new Session("current-session", process.cwd());
    const resume = createResumeSession({
      session: current,
      broker: {
        read: () => ({
          provider: "anthropic",
          model: "test-model",
          effort: "high",
          fastMode: false,
          permissionMode: "default",
          ultracode: false,
        }),
        dispatch: noop,
      },
      agent: { resetSessionScopedPermissions: noop, injections: { drain: () => [] } },
      sessionTitle: { setTitle: noop, setAttempted: noop, reset: noop },
      createPasteStore: () => ({ clear: noop }),
      recordsToTranscript: () => [],
      getRuntimeConfig: () => ({}),
      setTranscript: noop,
      setMainLastContext: noop,
      setUsageByProvider: noop,
      setMainTokenTotals: noop,
      pasteStoreRef: { current: { clear: noop } },
      suppressBrokerPersistenceRef: { current: false },
      persistedSessionBrokerStateRef: { current: "" },
      nextTranscriptId: (prefix: string) => `${prefix}_test`,
      transcriptBatch: { flushNow: noop },
      runSessionFinalizers: noop,
      resetRenderSurface: noop,
    } as unknown as ResumeSessionDeps);

    try {
      await resume(persisted.id);
      expect(wakes).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it("keeps title generation closed when a resumed session has no title", async () => {
    const persisted = new Session("untitled-resume", process.cwd());
    await appendRecord(persisted, {
      type: "user_message",
      ts: "2026-06-23T00:00:00.000Z",
      content: "hello",
    });

    const noop = (): void => {};
    const attempts: boolean[] = [];
    const titles: (string | null)[] = [];
    const current = new Session("current-session", process.cwd());
    const resume = createResumeSession({
      session: current,
      broker: {
        read: () => ({
          provider: "anthropic",
          model: "test-model",
          effort: "high",
          fastMode: false,
          permissionMode: "default",
          ultracode: false,
        }),
        dispatch: noop,
      },
      agent: { resetSessionScopedPermissions: noop, injections: { drain: () => [] } },
      sessionTitle: {
        setTitle: (title: string | null) => {
          titles.push(title);
        },
        setAttempted: (attempted: boolean) => {
          attempts.push(attempted);
        },
        reset: noop,
      },
      createPasteStore: () => ({ clear: noop }),
      recordsToTranscript: () => [],
      getRuntimeConfig: () => ({}),
      setTranscript: noop,
      setMainLastContext: noop,
      setUsageByProvider: noop,
      setMainTokenTotals: noop,
      pasteStoreRef: { current: { clear: noop } },
      suppressBrokerPersistenceRef: { current: false },
      persistedSessionBrokerStateRef: { current: "" },
      nextTranscriptId: (prefix: string) => `${prefix}_test`,
      transcriptBatch: { flushNow: noop },
      runSessionFinalizers: noop,
      resetRenderSurface: noop,
    } as unknown as ResumeSessionDeps);

    await resume(persisted.id);
    // A resumed session is past its first message, so the missing title must
    // not reopen generation — attempted stays latched after the async load.
    for (let tick = 0; tick < 20; tick++) await new Promise((r) => setTimeout(r, 5));

    expect(attempts).toEqual([true]);
    expect(titles).toEqual([null]);
  });

  it("resets the transcript view before replacing the current session", async () => {
    const persisted = new Session("view-reset-resume", process.cwd());
    await appendRecord(persisted, {
      type: "user_message",
      ts: "2026-06-23T00:00:00.000Z",
      content: "resumed message",
    });

    const noop = (): void => {};
    const order: string[] = [];
    const current = new Session("current-session", process.cwd());
    let currentEntries: readonly TranscriptEntry[] = [
      { id: "current-entry", kind: "user", text: "current message" },
    ];
    const resume = createResumeSession({
      session: current,
      broker: {
        read: () => ({
          provider: "anthropic",
          model: "test-model",
          effort: "high",
          fastMode: false,
          permissionMode: "default",
          ultracode: false,
        }),
        dispatch: noop,
      },
      agent: { resetSessionScopedPermissions: noop, injections: { drain: () => [] } },
      sessionTitle: { setTitle: noop, setAttempted: noop, reset: noop },
      createPasteStore: () => ({ clear: noop }),
      recordsToTranscript: () => [{ id: "resumed-entry", kind: "user", text: "resumed message" }],
      getRuntimeConfig: () => ({}),
      setTranscript: (value: Parameters<ResumeSessionDeps["setTranscript"]>[0]) => {
        order.push("replace");
        currentEntries = typeof value === "function" ? value(currentEntries) : value;
      },
      setMainLastContext: noop,
      setUsageByProvider: noop,
      setMainTokenTotals: noop,
      pasteStoreRef: { current: { clear: noop } },
      suppressBrokerPersistenceRef: { current: false },
      persistedSessionBrokerStateRef: { current: "" },
      nextTranscriptId: (prefix: string) => `${prefix}_test`,
      transcriptBatch: { flushNow: () => order.push("flush") },
      runSessionFinalizers: noop,
      resetRenderSurface: () => order.push("reset"),
    } as unknown as ResumeSessionDeps);

    await resume(persisted.id);

    expect(order.slice(-3)).toEqual(["reset", "replace", "flush"]);
    expect(currentEntries).toEqual([
      { id: "resumed-entry", kind: "user", text: "resumed message" },
    ]);
  });

  it("refuses the panel callback before mutating session state", async () => {
    const persistedCwd = join(base, "other-repo");
    const persisted = new Session("cross-directory-resume", persistedCwd);
    await appendRecord(persisted, {
      type: "user_message",
      ts: "2026-06-23T00:00:00.000Z",
      content: "hello",
    });

    let mutations = 0;
    const unexpectedMutation = (): never => {
      mutations += 1;
      throw new Error("resume mutated state before cwd validation");
    };
    const current = new Session("current-session", process.cwd());
    const resume = createResumeSession({
      session: current,
      broker: { read: unexpectedMutation, dispatch: unexpectedMutation },
      agent: { resetSessionScopedPermissions: unexpectedMutation },
      sessionTitle: {
        setTitle: unexpectedMutation,
        setAttempted: unexpectedMutation,
        reset: unexpectedMutation,
      },
      createPasteStore: unexpectedMutation,
      recordsToTranscript: unexpectedMutation,
      getRuntimeConfig: unexpectedMutation,
      setTranscript: unexpectedMutation,
      setMainLastContext: unexpectedMutation,
      setUsageByProvider: unexpectedMutation,
      setMainTokenTotals: unexpectedMutation,
      pasteStoreRef: { current: {} },
      suppressBrokerPersistenceRef: { current: false },
      persistedSessionBrokerStateRef: { current: "" },
      nextTranscriptId: unexpectedMutation,
      transcriptBatch: { flushNow: unexpectedMutation },
      runSessionFinalizers: unexpectedMutation,
      resetRenderSurface: unexpectedMutation,
    } as unknown as ResumeSessionDeps);

    await expect(resume(persisted.id)).rejects.toThrow(
      `This session belongs to a different directory. Open ${persistedCwd} to resume it.`,
    );
    expect(mutations).toBe(0);
    expect(current.id).toBe("current-session");
    expect(current.records).toHaveLength(0);
  });
});

describe("system injection side store", () => {
  let base: string;
  let savedConfigDir: string | undefined;
  let savedToolResultsDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "otherside-system-injection-test-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    savedToolResultsDir = process.env.OTHERSIDE_TOOL_RESULTS_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
    process.env.OTHERSIDE_TOOL_RESULTS_DIR = join(base, "tool-results");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.OTHERSIDE_CONFIG_DIR;
    } else {
      process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    }
    if (savedToolResultsDir === undefined) {
      delete process.env.OTHERSIDE_TOOL_RESULTS_DIR;
    } else {
      process.env.OTHERSIDE_TOOL_RESULTS_DIR = savedToolResultsDir;
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("keeps new system injections out of records and replays them from the side store", async () => {
    const session = new Session("system-injection-session", base);
    await appendRecord(session, {
      type: "injection_queued",
      ts: "2026-06-23T00:00:00.000Z",
      text: "system reminder",
      source: "system",
    });

    expect(session.records).toHaveLength(0);
    expect(session.systemInjections).toEqual([
      {
        ts: "2026-06-23T00:00:00.000Z",
        text: "system reminder",
        virtualIndex: 0,
      },
    ]);
    const stored = loadSystemInjectionsForSession(session.id, session.cwd);
    expect(stored).toEqual(session.systemInjections);

    const replayed: string[] = [];
    replayInjectionsFromRecords(
      [],
      {
        injections: { drain: () => [] },
        pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
      } as never,
      stored,
    );
    expect(replayed).toEqual(["system reminder"]);

    const afterCompact: string[] = [];
    replayInjectionsFromRecords(
      [
        {
          type: "compaction_mark",
          ts: "2026-06-23T00:00:01.000Z",
          summary_ref: "summary",
        },
      ],
      {
        injections: { drain: () => [] },
        pushInjectionInMemoryOnly: (text: string) => afterCompact.push(text),
      } as never,
      stored,
    );
    expect(afterCompact).toEqual([]);
  });

  it("keeps user injections in records for sync", async () => {
    const session = new Session("user-injection-session", base);
    await appendRecord(session, {
      type: "injection_queued",
      ts: "2026-06-23T00:00:00.000Z",
      text: "user reminder",
      source: "user",
    });

    expect(session.systemInjections).toHaveLength(0);
    expect(session.records).toHaveLength(1);
    expect(session.records[0]?.type).toBe("injection_queued");
  });

  it("replays only undelivered user injections", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:00.000Z",
          text: "answered",
          source: "user",
        },
        { type: "user_message", ts: "2026-07-20T00:00:01.000Z", content: "answered" },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:02.000Z",
          text: "pending",
          source: "user",
        },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["pending"]);
  });

  it("consumes one delivery per queued copy of the same text", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        { type: "injection_queued", ts: "2026-07-20T00:00:00.000Z", text: "again", source: "user" },
        { type: "user_message", ts: "2026-07-20T00:00:01.000Z", content: "again" },
        { type: "injection_queued", ts: "2026-07-20T00:00:02.000Z", text: "again", source: "user" },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["again"]);
  });

  it("never replays a queued injection consumed by a dequeue marker", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:00.000Z",
          text: "restored to prompt",
          source: "user",
        },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:01.000Z",
          text: "still pending",
          source: "user",
        },
        { type: "injection_dequeued", ts: "2026-07-20T00:00:02.000Z", text: "restored to prompt" },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["still pending"]);
  });

  it("never replays queued slash commands as model text", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:00.000Z",
          text: "/compact",
          source: "user",
        },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:01.000Z",
          text: "keep me",
          source: "user",
        },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["keep me"]);
  });

  it("never lets an earlier user message consume a later queued injection", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        { type: "user_message", ts: "2026-07-20T00:00:00.000Z", content: "typed idle" },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:01.000Z",
          text: "typed idle",
          source: "user",
        },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["typed idle"]);
  });

  it("consumes every queued entry delivered as one combined user message", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        { type: "injection_queued", ts: "2026-07-20T00:00:00.000Z", text: "first", source: "user" },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:01.000Z",
          text: "second",
          source: "user",
        },
        { type: "user_message", ts: "2026-07-20T00:00:02.000Z", content: "first\n\nsecond" },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual([]);
  });

  it("combined consumption skips entries absent from the combined delivery", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        { type: "injection_queued", ts: "2026-07-20T00:00:00.000Z", text: "first", source: "user" },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:01.000Z",
          text: "taken back",
          source: "user",
        },
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:02.000Z",
          text: "second",
          source: "user",
        },
        { type: "user_message", ts: "2026-07-20T00:00:03.000Z", content: "first\n\nsecond" },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["taken back"]);
  });

  it("never lets a combined delivery consume an unrelated superstring entry", () => {
    const replayed: string[] = [];
    const agent = {
      injections: { drain: () => [] },
      pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
    } as never;
    replayInjectionsFromRecords(
      [
        {
          type: "injection_queued",
          ts: "2026-07-20T00:00:00.000Z",
          text: "first\n\nsecond extended",
          source: "user",
        },
        { type: "user_message", ts: "2026-07-20T00:00:01.000Z", content: "first\n\nsecond" },
      ],
      agent,
      [],
    );
    expect(replayed).toEqual(["first\n\nsecond extended"]);
  });

  it("spills compaction summaries in memory while keeping the transcript inline", async () => {
    const session = new Session("summary-spill-session", base);
    await appendRecord(session, {
      type: "compaction_mark",
      ts: "2026-06-23T00:00:00.000Z",
      summary_ref: "summary kept inline on disk",
      trigger: "auto",
    });

    const record = session.records[0];
    expect(record?.type).toBe("compaction_mark");
    if (record?.type !== "compaction_mark") throw new Error("expected compaction mark");
    expect(typeof record.summary_ref).toBe("object");
    const ref = record.summary_ref;
    if (typeof ref === "string") throw new Error("expected spilled compaction summary");
    expect(readFileSync(ref.filepath, "utf8")).toBe("summary kept inline on disk");

    const line = readFileSync(sessionPathForCwd(session.cwd, session.id), "utf8");
    expect(line).toContain("summary kept inline on disk");
    expect(line).not.toContain("spilled_compaction_summary");
  });
});
