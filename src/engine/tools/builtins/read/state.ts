import { realpathSync, statSync } from "node:fs";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const READ_STATE_MAX_ENTRIES = 100;
const READ_STATE_MAX_BYTES = 25 * 1024 * 1024;

interface ReadStateEntry {
  timestamp: number;
  content: string;
  offset?: number;
  limit?: number;
}

export const MAIN_SCOPE = "main";

const READ_STATE = new Map<string, Map<string, ReadStateEntry>>();

export function readScopeKey(ctx: RequestContext): string {
  if (typeof ctx.parentThreadId === "string" && ctx.parentThreadId.length > 0) {
    // Each agent owns its read state so a completed agent's bucket can be
    // released at its lifecycle boundary and concurrent agents never evict
    // each other's entries. A child ctx without an owner id keeps the shared
    // per-session bucket, which session finalize clears.
    return ctx.agentOwnerId ?? ctx.sessionId;
  }
  return MAIN_SCOPE;
}

function getScopeBucket(scope: string): Map<string, ReadStateEntry> {
  let bucket = READ_STATE.get(scope);
  if (bucket === undefined) {
    bucket = new Map<string, ReadStateEntry>();
    READ_STATE.set(scope, bucket);
  }
  return bucket;
}

function setReadState(scope: string, key: string, entry: ReadStateEntry): void {
  const bucket = getScopeBucket(scope);
  bucket.delete(key);
  bucket.set(key, entry);
  evictReadStateOverflow(bucket);
}

function evictReadStateOverflow(bucket: Map<string, ReadStateEntry>): void {
  let bytes = readStateBytes(bucket);
  while (bucket.size > READ_STATE_MAX_ENTRIES || bytes > READ_STATE_MAX_BYTES) {
    const oldest = bucket.keys().next().value;
    if (oldest === undefined) break;
    const entry = bucket.get(oldest);
    bucket.delete(oldest);
    bytes -= entry ? readStateEntryBytes(entry) : 0;
  }
}

function readStateBytes(bucket: Map<string, ReadStateEntry>): number {
  let total = 0;
  for (const entry of bucket.values()) total += readStateEntryBytes(entry);
  return total;
}

function readStateEntryBytes(entry: ReadStateEntry): number {
  return Buffer.byteLength(entry.content);
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function readSetInsert(
  scope: string,
  path: string,
  content?: string,
  offset?: number,
  limit?: number,
): void {
  const key = canonicalize(path);
  let timestamp = Date.now();
  try {
    timestamp = statSync(path).mtimeMs;
  } catch {}
  const entry: ReadStateEntry = { timestamp, content: content ?? "" };
  if (offset !== undefined) entry.offset = offset;
  if (limit !== undefined) entry.limit = limit;
  setReadState(scope, key, entry);
}

export function readSetContains(scope: string, path: string): boolean {
  return READ_STATE.get(scope)?.has(canonicalize(path)) ?? false;
}

export function readState(scope: string, path: string): ReadStateEntry | undefined {
  return READ_STATE.get(scope)?.get(canonicalize(path));
}

export function updateReadState(scope: string, path: string, content: string): void {
  const key = canonicalize(path);
  let timestamp = Date.now();
  try {
    timestamp = statSync(path).mtimeMs;
  } catch {}
  setReadState(scope, key, { timestamp, content });
}

export function readSetClear(scope: string): void {
  READ_STATE.get(scope)?.clear();
}

export function readSetClearExcept(scope: string, paths: string[]): void {
  const bucket = READ_STATE.get(scope);
  if (bucket === undefined) return;
  const keep = new Set(paths.map((path) => canonicalize(path)));
  for (const key of [...bucket.keys()]) {
    if (!keep.has(key)) bucket.delete(key);
  }
}

export function readSetEntries(scope: string): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  const bucket = READ_STATE.get(scope);
  if (bucket === undefined) return out;
  for (const [path, entry] of bucket) {
    out.push({ path, mtime: entry.timestamp });
  }
  return out;
}

export function clearReadStateForScope(scope: string): void {
  READ_STATE.delete(scope);
}
