import { open } from "node:fs/promises";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { foreignMainChainHead, reconstructForeignConversation } from "./conversation-chain.ts";
import { findSessionPath, sessionCwdFilterFor } from "./paths.ts";
import {
  isChainParticipant,
  KNOWN_TYPES,
  type RecordType,
  recordsFromParsedLine,
  type SessionRecord,
  type UsageRecord,
} from "./record/index.ts";
import {
  findLastActiveBoundaryStart,
  parseLineEnvelope,
  readRange,
} from "./transcript/truncate.ts";

export async function readSessionLines(id: string): Promise<string[]> {
  const path = findSessionPath(id);
  if (path === null) return [];
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return streamNonEmptyLines(file, keepEveryLine);
}

export async function readMainChainLines(id: string): Promise<string[]> {
  const path = findSessionPath(id);
  if (path === null) return [];
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return streamNonEmptyLines(file, isMainChainLine);
}

const PRECOMPACT_SKIP_THRESHOLD_BYTES = 5 * 1024 * 1024;

function precompactSkipDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP);
}

export async function readActiveChainLines(id: string): Promise<string[]> {
  const path = findSessionPath(id);
  if (path === null) return [];
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const size = file.size;
  if (size <= PRECOMPACT_SKIP_THRESHOLD_BYTES || precompactSkipDisabled()) {
    return streamNonEmptyLines(file, isMainChainLine);
  }
  const handle = await open(path, "r");
  try {
    const boundaryStart = await findLastActiveBoundaryStart(handle, size);
    if (boundaryStart === null) return streamNonEmptyLines(file, isMainChainLine);
    const tail = (await readRange(handle, { start: boundaryStart, end: size })).toString("utf8");
    const out: string[] = [];
    for (const line of tail.split("\n")) {
      if (line.trim().length === 0) continue;
      if (isMainChainLine(line)) out.push(line);
    }
    if (out.length === 0) return streamNonEmptyLines(file, isMainChainLine);
    return out;
  } finally {
    await handle.close();
  }
}

function keepEveryLine(): boolean {
  return true;
}

function isMainChainLine(line: string): boolean {
  if (!line.includes('"isSidechain":true')) return true;
  return parseLineEnvelope(line)?.isSidechain !== true;
}

export async function streamNonEmptyLines(
  file: ReturnType<typeof Bun.file>,
  keep: (line: string) => boolean,
): Promise<string[]> {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of file.stream()) {
    carry += decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline = carry.indexOf("\n", start);
    while (newline !== -1) {
      const line = carry.slice(start, newline);
      if (line.trim().length > 0 && keep(line)) lines.push(line);
      start = newline + 1;
      newline = carry.indexOf("\n", start);
    }
    if (start > 0) carry = carry.slice(start);
  }
  carry += decoder.decode();
  if (carry.trim().length > 0 && keep(carry)) lines.push(carry);
  return lines;
}

export function recordsFromLines(lines: string[]): SessionRecord[] {
  if (lines.length === 0) return [];

  const foreignChain = reconstructForeignConversation(lines, { sidechain: false });
  if (foreignChain !== null) return recordsFromForeignChain(foreignChain);

  const out: SessionRecord[] = [];
  for (const line of lines) {
    const obj = parseLineEnvelope(line);
    if (!obj) continue;
    if (obj.isSidechain === true) continue;
    for (const rec of recordsFromParsedLine(obj)) out.push(rec);
  }
  return out;
}

const FOREIGN_CONVERSATION_LINE_TYPES = new Set(["user", "assistant", "summary"]);

function isForeignConversationLine(raw: Record<string, unknown>): boolean {
  const type = raw.type;
  if (typeof type !== "string") return false;
  if (FOREIGN_CONVERSATION_LINE_TYPES.has(type)) return true;
  return type === "system" && raw.subtype === "compact_boundary";
}

function recordsFromForeignChain(chain: Record<string, unknown>[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const raw of chain) {
    if (!isForeignConversationLine(raw)) continue;
    for (const rec of recordsFromParsedLine(raw)) out.push(rec);
  }
  return out;
}

export function chainHeadFromLines(lines: string[]): string | null {
  if (lines.length === 0) return null;
  return nativeChainHead(lines) ?? foreignMainChainHead(lines);
}

export interface ResumeLoad {
  records: SessionRecord[];
  usageRecords: UsageRecord[];
  chainHead: string | null;
  cwd: string | null;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No conversation found with session ID: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

function partitionResumeRecords(all: SessionRecord[]): {
  records: SessionRecord[];
  usageRecords: UsageRecord[];
} {
  const records: SessionRecord[] = [];
  const usageRecords: UsageRecord[] = [];
  for (const r of all) {
    if (r.type === "usage") {
      usageRecords.push(r as UsageRecord);
    } else if (r.type === "hook_event") {
      // hook events are session-live only; goal state does not survive resume
    } else {
      records.push(r);
    }
  }
  return { records, usageRecords };
}

export async function loadSessionForResume(
  id: string,
  currentCwd = process.cwd(),
): Promise<ResumeLoad> {
  if (findSessionPath(id) === null) throw new SessionNotFoundError(id);
  const lines = await readMainChainLines(id);
  await assertResumeCwd(lines, currentCwd);
  const allRecords = recordsFromLines(lines);
  const { records, usageRecords } = partitionResumeRecords(allRecords);
  return {
    records,
    usageRecords,
    chainHead: chainHeadFromLines(lines),
    cwd: persistedCwdFromLines(lines),
  };
}

async function assertResumeCwd(lines: string[], currentCwd: string): Promise<void> {
  const persistedCwd = persistedCwdFromLines(lines);
  if (persistedCwd === null) return;
  const canonicalPersistedCwd = canonicalizeCwd(persistedCwd);
  const filter = await sessionCwdFilterFor(currentCwd);
  if (filter.matchSet.has(persistedCwd) || filter.matchSet.has(canonicalPersistedCwd)) return;
  throw new Error(
    `This session belongs to a different directory. Open ${persistedCwd} to resume it.`,
  );
}

function persistedCwdFromLines(lines: string[]): string | null {
  for (const line of lines) {
    const envelope = parseLineEnvelope(line);
    if (envelope === null) continue;
    return typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : null;
  }
  return null;
}

export async function loadSession(id: string): Promise<SessionRecord[]> {
  return recordsFromLines(await readMainChainLines(id));
}

export async function loadSessionChainHead(id: string): Promise<string | null> {
  return chainHeadFromLines(await readMainChainLines(id));
}

const CHAIN_PARTICIPANT_LINE_TYPES = new Set(["user", "assistant", "attachment"]);

function isChainParticipantLine(env: Record<string, unknown>): boolean {
  if (typeof env.type !== "string") return false;
  if (CHAIN_PARTICIPANT_LINE_TYPES.has(env.type)) return true;
  return env.type === "system" && env.subtype === "compact_boundary";
}

function nativeChainHead(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const env = parseLineEnvelope(line);
    if (!env || !("_os" in env)) continue;
    if (env.isSidechain === true) continue;
    const recordType = nativeRecordType(env._os);
    if (recordType) {
      if (!isChainParticipant(recordType)) continue;
    } else if (!isChainParticipantLine(env)) {
      continue;
    }
    if (typeof env.uuid === "string") return env.uuid;
  }
  return null;
}

function nativeRecordType(sidecar: unknown): RecordType | null {
  if (!sidecar || typeof sidecar !== "object") return null;
  const type = (sidecar as Record<string, unknown>).type;
  if (typeof type !== "string") return null;
  return KNOWN_TYPES.has(type as RecordType) ? (type as RecordType) : null;
}
