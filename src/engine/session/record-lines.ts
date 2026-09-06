import { foreignMainChainHead, reconstructForeignConversation } from "./conversation-chain.ts";
import { isTranscriptLinked, recordsFromParsedLine, type SessionRecord } from "./record/index.ts";
import {
  hasCompactionSummary,
  isChainParticipantLine,
  nativeRecordType,
} from "./record-envelope.ts";
import { parseLineEnvelope } from "./transcript/truncate.ts";

export function recordsFromLines(lines: string[]): SessionRecord[] {
  return recordsFromLinesWithOffsets(lines).records;
}

export interface OffsetTaggedRecords {
  records: SessionRecord[];
  /** Parallel to each produced record: source line offset (file or synthetic). */
  recordOffsets: number[];
}

export function recordsFromLinesWithOffsets(
  lines: string[],
  lineOffsets?: readonly number[],
): OffsetTaggedRecords {
  if (lines.length === 0) return { records: [], recordOffsets: [] };

  const foreignChain = reconstructForeignConversation(lines, { sidechain: false });
  if (foreignChain !== null) {
    const records = recordsFromForeignChain(foreignChain);
    return {
      records,
      // Foreign reconstruction loses per-line offsets; mark as non-boundary-filterable.
      recordOffsets: records.map(() => -1),
    };
  }

  const records: SessionRecord[] = [];
  const recordOffsets: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const obj = parseLineEnvelope(line);
    if (!obj) continue;
    if (obj.isSidechain === true) continue;
    const offset = lineOffsets?.[i] ?? i;
    for (const rec of recordsFromParsedLine(obj)) {
      records.push(rec);
      recordOffsets.push(offset);
    }
  }
  return { records, recordOffsets };
}

/**
 * Parse lines into records, reusing results for identical line text. Boundary
 * lines share most strings with the full plan; only rewritten lines re-parse.
 */
export function recordsFromLinesCached(
  lines: string[],
  cache: Map<string, SessionRecord[]>,
): SessionRecord[] {
  if (lines.length === 0) return [];

  // Foreign reconstruction needs the whole line set at once.
  const foreignChain = reconstructForeignConversation(lines, { sidechain: false });
  if (foreignChain !== null) return recordsFromForeignChain(foreignChain);

  const out: SessionRecord[] = [];
  for (const line of lines) {
    let recs = cache.get(line);
    if (recs === undefined) {
      recs = [];
      const obj = parseLineEnvelope(line);
      if (obj && obj.isSidechain !== true) {
        for (const rec of recordsFromParsedLine(obj)) recs.push(rec);
      }
      cache.set(line, recs);
    }
    for (const rec of recs) out.push(rec);
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

function nativeChainHead(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const env = parseLineEnvelope(line);
    if (!env || !("_os" in env)) continue;
    if (env.isSidechain === true) continue;
    if (env.subtype === "compact_boundary" && !hasCompactionSummary(env)) continue;
    const recordType = nativeRecordType(env._os);
    if (recordType) {
      if (!isTranscriptLinked(recordType)) continue;
    } else if (!isChainParticipantLine(env)) {
      continue;
    }
    if (typeof env.uuid === "string") return env.uuid;
  }
  return null;
}
