import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import { enqueueWrite, invalidateOffsetIndex } from "./infra.ts";
import { sessionPathForCwd } from "./paths.ts";
import { type Session, SessionChain, serializeRecord } from "./record/index.ts";
import { parseLineEnvelope, titleLineType } from "./transcript/truncate.ts";

interface SidechainLine {
  line: string;
  parentToolCallId: string | undefined;
}

interface PreservedLines {
  sidechains: SidechainLine[];
  titleLines: string[];
}

export function rewriteSession(s: Session): Promise<void> {
  const path = sessionPathForCwd(s.storageCwd, s.id);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const records = s.pendingMeta ? [s.pendingMeta, ...s.records] : s.records;
  const chain = new SessionChain();
  s.chain.headUuid = null;
  const stamp = s.stamp();
  const mainLines: string[] = records.map((r) => serializeRecord(r, chain, stamp));
  s.chain.headUuid = chain.headUuid;
  const callIdToLineIndex = new Map<string, number>();
  const survivingCallIds = new Set<string>();
  records.forEach((r, index) => {
    if (r.type === "tool_call") {
      survivingCallIds.add(r.call_id);
      callIdToLineIndex.set(r.call_id, index);
    }
  });
  return enqueueWrite(path, async () => {
    const preserved = await readPreservedLines(path, survivingCallIds);
    const payload =
      interleaveSidechains(mainLines, preserved.sidechains, callIdToLineIndex) +
      preserved.titleLines.map((l) => `${l}\n`).join("");
    atomicWriteFileSync(path, payload);
    invalidateOffsetIndex(path);
  });
}

function isPreservedCandidateLine(line: string): boolean {
  return titleLineType(line) !== null || line.includes('"isSidechain":true');
}

async function readPreservedLines(
  path: string,
  survivingCallIds: Set<string>,
): Promise<PreservedLines> {
  const file = Bun.file(path);
  let candidates: string[];
  try {
    if (!(await file.exists())) return { sidechains: [], titleLines: [] };
    candidates = await streamPreservedLines(file, isPreservedCandidateLine);
  } catch {
    return { sidechains: [], titleLines: [] };
  }
  const sidechains: SidechainLine[] = [];
  const lastTitleByType = new Map<string, string>();
  for (const line of candidates) {
    const titleType = titleLineType(line);
    if (titleType !== null) {
      lastTitleByType.set(titleType, line);
      continue;
    }
    const env = parseLineEnvelope(line);
    if (!env || env.isSidechain !== true) continue;
    const sidecar = env._os;
    const parentToolCallId =
      sidecar && typeof sidecar === "object"
        ? (sidecar as { parentToolCallId?: unknown }).parentToolCallId
        : undefined;
    const parent = typeof parentToolCallId === "string" ? parentToolCallId : undefined;
    if (parent !== undefined && !survivingCallIds.has(parent)) continue;
    sidechains.push({ line, parentToolCallId: parent });
  }
  return { sidechains, titleLines: [...lastTitleByType.values()] };
}

async function streamPreservedLines(
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

function interleaveSidechains(
  mainLines: string[],
  sidechains: SidechainLine[],
  callIdToLineIndex: Map<string, number>,
): string {
  if (sidechains.length === 0) return mainLines.map((l) => `${l}\n`).join("");
  const afterLine = new Map<number, string[]>();
  const trailing: string[] = [];
  for (const sidechain of sidechains) {
    const parentIndex =
      sidechain.parentToolCallId !== undefined
        ? callIdToLineIndex.get(sidechain.parentToolCallId)
        : undefined;
    if (parentIndex === undefined) {
      trailing.push(sidechain.line);
      continue;
    }
    const bucket = afterLine.get(parentIndex) ?? [];
    bucket.push(sidechain.line);
    afterLine.set(parentIndex, bucket);
  }
  const parts: string[] = [];
  mainLines.forEach((line, index) => {
    parts.push(line);
    const attached = afterLine.get(index);
    if (attached) for (const sc of attached) parts.push(sc);
  });
  for (const sc of trailing) parts.push(sc);
  return parts.map((l) => `${l}\n`).join("");
}
