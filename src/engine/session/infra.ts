import { type FileHandle, stat } from "node:fs/promises";
import { agentTranscriptPathForCwd } from "./paths.ts";
import { SessionChain } from "./record/index.ts";
import { type AnchorLine, verifyAnchorCandidate } from "./transcript/truncate.ts";

const writeChains = new Map<string, Promise<unknown>>();

export interface SessionOffsetIndex {
  fileSize: number;
  byUuid: Map<string, number>;
}

const offsetIndexes = new Map<string, SessionOffsetIndex>();
export const OFFSET_INDEX_MAX_UUIDS = 50_000;

export const KEPT_TAIL_MAX_BYTES = 16 * 1024 * 1024;

export function invalidateOffsetIndex(path: string): void {
  offsetIndexes.delete(path);
}

export async function offsetIndexForAppend(path: string): Promise<SessionOffsetIndex> {
  let index = offsetIndexes.get(path);
  if (!index) {
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0;
    }
    index = { fileSize: size, byUuid: new Map() };
    offsetIndexes.set(path, index);
  }
  return index;
}

export function recordAppendedLine(
  index: SessionOffsetIndex,
  uuid: string | null,
  lineBytes: number,
): void {
  if (uuid !== null) {
    if (index.byUuid.size >= OFFSET_INDEX_MAX_UUIDS) {
      const oldest = index.byUuid.keys().next().value;
      if (oldest !== undefined) index.byUuid.delete(oldest);
    }
    index.byUuid.set(uuid, index.fileSize);
  }
  index.fileSize += lineBytes;
}

export async function anchorFromIndex(
  handle: FileHandle,
  lookup: { path: string; anchorUuid: string; fileSize: number },
): Promise<AnchorLine | null> {
  const index = offsetIndexes.get(lookup.path);
  if (!index || index.fileSize !== lookup.fileSize) return null;
  const offset = index.byUuid.get(lookup.anchorUuid);
  if (offset === undefined || offset >= lookup.fileSize) return null;
  return verifyAnchorCandidate(handle, {
    matchOffset: offset,
    fileSize: lookup.fileSize,
    anchorUuid: lookup.anchorUuid,
  });
}

export function enqueueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prior = writeChains.get(path) ?? Promise.resolve();
  const run = prior.then(
    () => task(),
    () => task(),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(path, settled);
  // The map only serializes in-flight writes; once this tail settles with no
  // newer write chained after it, the entry is dead weight — a long session
  // touching many paths would otherwise grow the map for the process lifetime.
  void settled.then(() => {
    if (writeChains.get(path) === settled) writeChains.delete(path);
  });
  return run;
}

export function pendingWriteChainCount(): number {
  return writeChains.size;
}

const rawChains = new Map<string, SessionChain>();

export function rawChainFor(sessionId: string): SessionChain {
  let chain = rawChains.get(sessionId);
  if (!chain) {
    chain = new SessionChain();
    rawChains.set(sessionId, chain);
  }
  return chain;
}

// Subagent forks chain under `${sessionId}/${agentId}` keys (persist/append.ts) and
// never reclaim them. Drop a session's fork sub-chains at lifecycle boundaries; the
// bare `sessionId` chain is left intact since the session itself may keep appending.
export function releaseSessionForkChains(sessionId: string): void {
  const prefix = `${sessionId}/`;
  for (const key of rawChains.keys()) {
    if (key.startsWith(prefix)) rawChains.delete(key);
  }
}

// A finished fork never appends again; drop its per-fork persist state so a
// long-lived session that spawns many forks doesn't retain one entry per fork for
// the process lifetime. The raw chain, the writeChains serializer, AND the append
// offset index (whose byUuid map grows toward OFFSET_INDEX_MAX_UUIDS per fork) are
// otherwise never reclaimed until the whole session is finalized.
export function releaseForkChain(sessionId: string, agentId: string, cwd: string): void {
  const path = agentTranscriptPathForCwd(cwd, sessionId, agentId);
  rawChains.delete(`${sessionId}/${agentId}`);
  writeChains.delete(path);
  invalidateOffsetIndex(path);
}
