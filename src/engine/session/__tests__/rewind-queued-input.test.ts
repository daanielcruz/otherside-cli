import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@/engine/queue/index.ts";
import { appendRecord } from "@/engine/session/append.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { Session } from "@/engine/session/record/state.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { replayInjectionsFromRecords } from "@/engine/session/resume.ts";
import { loadSessionForResume } from "@/engine/session/resume-load.ts";
import { createRewindToTranscriptId } from "@/engine/session/rewind.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

const QUEUED_TEXT = "a request meant for another project";

const broker: BrokerHandle = {
  read: () => ({
    provider: "anthropic",
    model: "claude-sonnet-5",
    effort: "high",
    fastMode: false,
    permissionMode: "default",
    orchestrationMode: "disabled",
  }),
  dispatch: () => {},
};

const pasteStore: PasteStore = {
  add: () => ({ id: 1, placeholder: "" }),
  get: () => undefined,
  list: () => [],
  clear: () => {},
};

let base: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-rewind-queued-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(base, { recursive: true, force: true });
});

function userEntry(id: string, record: SessionRecord): TranscriptEntry {
  if (record.type !== "user_message" || record.uuid === undefined) {
    throw new Error("expected a persisted user message");
  }
  return { id, kind: "user", text: record.content, anchor: record.uuid };
}

async function untilRecorded(session: Session, type: SessionRecord["type"]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (session.records.some((record) => record.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`no ${type} record was written`);
}

describe("rewinding past a delivered queued input", () => {
  it("withdraws the input from the next turn and from a later resume", async () => {
    const session = new Session("rewind-queued-input", base);
    const agent = new Agent({ broker, session, config: DEFAULT_CONFIG, getLastUsage: () => null });
    const ts = (): string => new Date().toISOString();
    await appendRecord(session, { type: "user_message", ts: ts(), content: "keep this turn" });
    const kept = session.records.at(-1);
    await appendRecord(session, {
      type: "injection_queued",
      ts: ts(),
      text: QUEUED_TEXT,
      source: "user",
    });
    await appendRecord(session, { type: "user_message", ts: ts(), content: QUEUED_TEXT });
    const delivered = session.records.at(-1);
    if (!kept || !delivered) throw new Error("expected both user messages");
    const entries = [userEntry("kept", kept), userEntry("delivered", delivered)];

    const rewind = createRewindToTranscriptId({
      session,
      broker,
      agent,
      queueActions: { clear: () => {} },
      getRuntimeConfig: () => DEFAULT_CONFIG,
      setTranscript: () => {},
      setMainLastContext: () => {},
      setPromptText: () => {},
      pasteStoreRef: { current: pasteStore },
      suppressBrokerPersistenceRef: { current: false },
      persistedSessionBrokerStateRef: { current: "" },
      pendingBrokerMetaRef: { current: null },
      overlayStack: { closeTop: () => {} },
      transcriptBatch: { flushNow: () => {} },
      getTranscriptEntries: () => entries,
      resetRenderSurface: () => {},
      findRewindCutIndex: (records, anchor) =>
        records.findIndex((record) => record.type === "user_message" && record.uuid === anchor),
      estimateTokens: () => 0,
    });
    rewind("delivered");

    expect(agent.injections.peek()).not.toContain(QUEUED_TEXT);
    await untilRecorded(session, "injection_dequeued");
    const resumed = await loadSessionForResume(session.id, base);
    const replayed: string[] = [];
    replayInjectionsFromRecords(
      resumed.records,
      {
        injections: { drain: () => [] },
        pushInjectionInMemoryOnly: (text: string) => replayed.push(text),
      } as never,
      [],
    );
    expect(replayed).toEqual([]);
  });
});
