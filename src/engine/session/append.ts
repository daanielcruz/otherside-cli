import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spillCompactionSummaryForMemory } from "./compact/summary-spill.ts";
import { enqueueWrite, offsetIndexForAppend, rawChainFor, recordAppendedLine } from "./infra.ts";
import { agentTranscriptPathForCwd, sessionPathForCwd } from "./paths.ts";
import {
  type HookEventRecord,
  type Session,
  SessionChain,
  type SessionRecord,
  type SessionStamp,
  serializeRecord,
  type UsageRecord,
} from "./record/index.ts";
import { appendSystemInjection } from "./system-injection-store.ts";

export async function appendRecordRaw(
  cwd: string,
  sessionId: string,
  r: SessionRecord,
): Promise<void> {
  const path = sessionPathForCwd(cwd, sessionId);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const stamp: SessionStamp = { sessionId, cwd };
  const line = `${serializeRecord(r, rawChainFor(sessionId), stamp)}\n`;
  await enqueueWrite(path, async () => {
    const index = await offsetIndexForAppend(path);
    await appendFile(path, line, "utf8");
    recordAppendedLine(index, null, Buffer.byteLength(line, "utf8"));
  });
}

export async function appendAgentRecordRaw(
  ref: { cwd: string; sessionId: string; agentId: string },
  r: SessionRecord,
): Promise<void> {
  const path = agentTranscriptPathForCwd(ref.cwd, ref.sessionId, ref.agentId);
  mkdirSync(dirname(path), { recursive: true });
  const stamp: SessionStamp = { sessionId: ref.sessionId, cwd: ref.cwd };
  const line = `${serializeRecord(r, rawChainFor(`${ref.sessionId}/${ref.agentId}`), stamp)}\n`;
  await enqueueWrite(path, () => appendFile(path, line, "utf8"));
}

export async function appendRawLine(path: string, line: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await enqueueWrite(path, async () => {
    const index = await offsetIndexForAppend(path);
    await appendFile(path, `${line}\n`, "utf8");
    recordAppendedLine(index, null, Buffer.byteLength(`${line}\n`, "utf8"));
  });
}

export async function appendHookEventRecord(s: Session, r: HookEventRecord): Promise<void> {
  // Hook events live only in memory (s.hookEvents, capped FIFO). They are not persisted to the transcript jsonl because hook lifecycles use a separate in-memory store outside the main transcript. Goal state does not survive resume; the user re-sets /goal if still relevant.
  s.pushHookEvent(r);
}

export async function appendUsageRecord(s: Session, r: UsageRecord): Promise<void> {
  // Usage records persist to the transcript jsonl (they are the only ledger source
  // for fork/estimated spend — see src/engine/session/usage/store.ts sidechain comment)
  // but are held in memory in the capped `usageRecords` store, never `records[]`.
  s.pushUsageRecord(r);
  const stamp = s.stamp();
  const lines = drainPendingMetaLine(s, stamp);
  lines.push({ text: `${serializeRecord(r, s.chain, stamp)}\n`, uuid: null });
  await writeSessionLines(s, lines);
}

export async function appendRecord(s: Session, r: SessionRecord): Promise<void> {
  if (r.type === "injection_queued" && r.source !== "user") {
    await appendSystemInjection(s, r);
    return;
  }

  // Serialization advances the transcript chain, so perform it against a private
  // copy. Nothing observable on the live session may change until the write has
  // completed successfully.
  const generatedUuid = isUuidRecord(r) && typeof r.uuid !== "string" ? crypto.randomUUID() : null;
  const recordForPersistence = withGeneratedUuid(r, generatedUuid);
  const recordForMemory =
    recordForPersistence.type === "compaction_mark"
      ? {
          ...recordForPersistence,
          summary_ref: await spillCompactionSummaryForMemory(recordForPersistence.summary_ref),
        }
      : recordForPersistence;
  await persistRecordAndCommit(s, {
    record: r,
    recordForPersistence,
    recordForMemory,
    generatedUuid,
  });
}

interface PendingRecordWrite {
  record: SessionRecord;
  recordForPersistence: SessionRecord;
  recordForMemory: SessionRecord;
  generatedUuid: string | null;
}

async function persistRecordAndCommit(s: Session, pending: PendingRecordWrite): Promise<void> {
  const path = sessionPathForCwd(s.storageCwd, s.id);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  await enqueueWrite(path, async () => {
    const pendingMeta = pending.record.type === "session_meta" ? null : s.pendingMeta;
    const pendingChain = new SessionChain();
    pendingChain.headUuid = s.chain.headUuid;
    const stamp = s.stamp();
    const lines: { text: string; uuid: string | null }[] = [];

    if (pendingMeta !== null) {
      lines.push({ text: `${serializeRecord(pendingMeta, pendingChain, stamp)}\n`, uuid: null });
    }
    const recordUuid =
      isUuidRecord(pending.recordForPersistence) &&
      typeof pending.recordForPersistence.uuid === "string"
        ? pending.recordForPersistence.uuid
        : null;
    lines.push({
      text: `${serializeRecord(pending.recordForPersistence, pendingChain, stamp)}\n`,
      uuid: recordUuid,
    });

    const payload = lines.map((line) => line.text).join("");
    const index = await offsetIndexForAppend(path);
    await appendFile(path, payload, "utf8");
    for (const line of lines) {
      recordAppendedLine(index, line.uuid, Buffer.byteLength(line.text, "utf8"));
    }

    if (pending.generatedUuid !== null && isUuidRecord(pending.record)) {
      pending.record.uuid = pending.generatedUuid;
    }
    if (pendingMeta !== null) {
      s.pushRecord(pendingMeta);
      s.pendingMeta = null;
    } else if (pending.record.type === "session_meta") {
      s.pendingMeta = null;
    }
    s.pushRecord(
      pending.recordForMemory.type === "compaction_mark" ? pending.recordForMemory : pending.record,
    );
    s.chain.headUuid = pendingChain.headUuid;
  });
}

type UuidRecord = Extract<
  SessionRecord,
  {
    type:
      | "user_message"
      | "assistant_message"
      | "tool_call"
      | "tool_result"
      | "attachment"
      | "compaction_mark";
  }
>;

function withGeneratedUuid(record: SessionRecord, uuid: string | null): SessionRecord {
  if (uuid === null || !isUuidRecord(record)) return record;
  return { ...record, uuid };
}

function isUuidRecord(record: SessionRecord): record is UuidRecord {
  return (
    record.type === "user_message" ||
    record.type === "assistant_message" ||
    record.type === "tool_call" ||
    record.type === "tool_result" ||
    record.type === "attachment" ||
    record.type === "compaction_mark"
  );
}

async function writeSessionLines(
  s: Session,
  lines: { text: string; uuid: string | null }[],
): Promise<void> {
  const payload = lines.map((l) => l.text).join("");
  const path = sessionPathForCwd(s.storageCwd, s.id);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  await enqueueWrite(path, async () => {
    const index = await offsetIndexForAppend(path);
    await appendFile(path, payload, "utf8");
    for (const line of lines) {
      recordAppendedLine(index, line.uuid, Buffer.byteLength(line.text, "utf8"));
    }
  });
}

function drainPendingMetaLine(
  s: Session,
  stamp: SessionStamp,
): { text: string; uuid: string | null }[] {
  if (s.pendingMeta !== null) {
    const meta = s.pendingMeta;
    s.pushRecord(meta);
    s.pendingMeta = null;
    return [{ text: `${serializeRecord(meta, s.chain, stamp)}\n`, uuid: null }];
  }
  return [];
}
