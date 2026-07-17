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

import { sessionPathForCwd } from "@/engine/session/paths.ts";
import { appendRecord, loadSessionForResume } from "@/engine/session/persist.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { Session } from "@/engine/session/record/state.ts";
import { loadSystemInjectionsForSession } from "@/engine/session/system-injection-store.ts";
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

  it("reconstructs contentReplacementState from records", () => {
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
    expect(session.contentReplacementState).toBeDefined();
    expect(session.contentReplacementState?.replacements.get("call-1")).toBe(
      "replaced content sentinel",
    );
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
