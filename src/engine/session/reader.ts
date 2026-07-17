import { type FileHandle, open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isProviderId, type ProviderId } from "@/kernel/config/provider-ids.ts";
import { canonicalizeCwd, projectSlug } from "@/kernel/std/fs/paths.ts";
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
import { type PrecompactChainEntry, planPrecompactChain } from "./transcript/precompact-chain.ts";
import { parseLineEnvelope } from "./transcript/truncate.ts";

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

const PRECOMPACT_SKIP_THRESHOLD_BYTES = 5_242_880;
const TRANSCRIPT_SCAN_BUFFER_BYTES = 1_048_576;
const NEWLINE_BYTE = 0x0a;
/** Fully-typed chain entries kept at the end of a large resume load (covers cap+step). */
const DEFAULT_RESUME_TAIL_CHAIN_ENTRIES = 1000;

function resumeTailChainEntries(): number {
  const raw = process.env.OTHERSIDE_RESUME_TAIL_ENTRIES;
  if (raw === undefined || raw.length === 0) return DEFAULT_RESUME_TAIL_CHAIN_ENTRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RESUME_TAIL_CHAIN_ENTRIES;
}

function precompactSkipDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP);
}

interface TranscriptMetadataOffsets {
  all: Set<number>;
  latestSessionMeta?: number;
  latestLastPrompt?: number;
  latestAttribution?: number;
}

export async function readActiveChainLines(id: string): Promise<string[]> {
  return (await readResumeChainLines(id)).full;
}

interface ResumeChainLines {
  full: string[];
  boundary: string[];
  /** File offsets for each entry in `full`, parallel to the line array. */
  fullOffsets: number[];
  /** File offsets that belong to the boundary plan (subset of the full plan). */
  boundaryOffsetSet: ReadonlySet<number>;
}

async function readResumeChainLines(id: string): Promise<ResumeChainLines> {
  const path = findSessionPath(id);
  if (path === null) return emptyResumeChainLines();
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyResumeChainLines();
  const size = file.size;
  const lines = () => streamNonEmptyLines(file, isMainChainLine);
  if (precompactSkipDisabled()) {
    const full = await lines();
    return resumeChainLinesFromMaterialized(full, normalizePreservedLines(full, "boundary"));
  }
  if (size <= PRECOMPACT_SKIP_THRESHOLD_BYTES) {
    return plannedChainLinesFromLines(await lines());
  }

  const handle = await open(path, "r");
  try {
    const entries: PrecompactChainEntry[] = [];
    const metadata: TranscriptMetadataOffsets = { all: new Set() };
    let latestUuid: string | undefined;
    let selectedLeafUuid: string | undefined;

    await scanTranscriptLines(handle, size, (line, offset) => {
      const envelope = parseLineEnvelope(line.toString("utf8"));
      if (envelope === null || envelope.isSidechain === true) return;
      if (envelope.type === "attribution-snapshot") {
        metadata.latestAttribution = offset;
        return;
      }
      if (envelope.type === "last-prompt") {
        if (typeof envelope.leafUuid === "string") selectedLeafUuid = envelope.leafUuid;
        metadata.latestLastPrompt = offset;
        return;
      }
      if (isSessionMetaEnvelope(envelope)) {
        metadata.latestSessionMeta = offset;
        return;
      }

      const uuid = typeof envelope.uuid === "string" ? envelope.uuid : undefined;
      if (uuid === undefined || !("parentUuid" in envelope) || !isChainEnvelope(envelope)) {
        metadata.all.add(offset);
        return;
      }
      entries.push(precompactEntryFromEnvelope(envelope, uuid, offset));
      latestUuid = uuid;
    });

    const plans = plannedChainPlans(entries, metadata, latestUuid, selectedLeafUuid);
    const selectedOffsets = new Set([
      ...plans.full.plan.ordered.map((entry) => entry.offset),
      ...plans.full.metadata,
      ...plans.boundary.plan.ordered.map((entry) => entry.offset),
      ...plans.boundary.metadata,
    ]);
    const textByOffset = new Map<number, string>();
    await scanTranscriptLines(
      handle,
      size,
      (line, offset) => {
        const text = line.toString("utf8");
        if (text.trim().length > 0 && isMainChainLine(text)) textByOffset.set(offset, text);
      },
      selectedOffsets,
    );
    return {
      full: renderPlannedLines(plans.full.plan, textByOffset, plans.full.metadata),
      boundary: renderPlannedLines(plans.boundary.plan, textByOffset, plans.boundary.metadata),
      fullOffsets: plannedLineOffsets(plans.full.plan, textByOffset, plans.full.metadata),
      boundaryOffsetSet: new Set([
        ...plans.boundary.plan.ordered.map((entry) => entry.offset),
        ...plans.boundary.metadata,
      ]),
    };
  } finally {
    await handle.close();
  }
}

function emptyResumeChainLines(): ResumeChainLines {
  return { full: [], boundary: [], fullOffsets: [], boundaryOffsetSet: new Set() };
}

function resumeChainLinesFromMaterialized(full: string[], boundary: string[]): ResumeChainLines {
  // Synthetic sequential offsets for in-memory line arrays (small-file / skip-disabled path).
  const fullOffsets = full.map((_, index) => index);
  const boundaryOffsetSet = new Set<number>();
  if (boundary.length > 0 && full.length > 0) {
    const fullIndexByLine = new Map<string, number>();
    for (let i = 0; i < full.length; i += 1) {
      const line = full[i];
      if (line !== undefined && !fullIndexByLine.has(line)) fullIndexByLine.set(line, i);
    }
    for (const line of boundary) {
      const idx = fullIndexByLine.get(line);
      if (idx !== undefined) boundaryOffsetSet.add(idx);
    }
  }
  return { full, boundary, fullOffsets, boundaryOffsetSet };
}

function normalizePreservedLines(lines: string[], scope: "boundary" | "full"): string[] {
  return plannedChainLinesFromLines(lines)[scope];
}

function plannedChainLinesFromLines(lines: string[]): ResumeChainLines {
  const entries: PrecompactChainEntry[] = [];
  const metadata: TranscriptMetadataOffsets = { all: new Set() };
  let latestUuid: string | undefined;
  let selectedLeafUuid: string | undefined;
  for (let offset = 0; offset < lines.length; offset += 1) {
    const text = lines[offset];
    if (text === undefined) continue;
    const envelope = parseLineEnvelope(text);
    if (envelope === null || envelope.isSidechain === true) continue;
    if (envelope.type === "attribution-snapshot") {
      metadata.latestAttribution = offset;
      continue;
    }
    if (envelope.type === "last-prompt") {
      if (typeof envelope.leafUuid === "string") selectedLeafUuid = envelope.leafUuid;
      metadata.latestLastPrompt = offset;
      continue;
    }
    if (isSessionMetaEnvelope(envelope)) {
      metadata.latestSessionMeta = offset;
      continue;
    }

    const uuid = typeof envelope.uuid === "string" ? envelope.uuid : undefined;
    if (uuid === undefined || !("parentUuid" in envelope) || !isChainEnvelope(envelope)) {
      metadata.all.add(offset);
      continue;
    }
    entries.push(precompactEntryFromEnvelope(envelope, uuid, offset));
    latestUuid = uuid;
  }
  const plans = plannedChainPlans(entries, metadata, latestUuid, selectedLeafUuid);
  const byOffset = new Map(lines.map((line, offset) => [offset, line]));
  return {
    full: renderPlannedLines(plans.full.plan, byOffset, plans.full.metadata),
    boundary: renderPlannedLines(plans.boundary.plan, byOffset, plans.boundary.metadata),
    fullOffsets: plannedLineOffsets(plans.full.plan, byOffset, plans.full.metadata),
    boundaryOffsetSet: new Set([
      ...plans.boundary.plan.ordered.map((entry) => entry.offset),
      ...plans.boundary.metadata,
    ]),
  };
}

function plannedChainPlans(
  entries: readonly PrecompactChainEntry[],
  metadata: TranscriptMetadataOffsets,
  latestUuid: string | undefined,
  selectedLeafUuid: string | undefined,
): {
  full: { plan: ReturnType<typeof planPrecompactChain>; metadata: Set<number> };
  boundary: { plan: ReturnType<typeof planPrecompactChain>; metadata: Set<number> };
} {
  const fullPlan = planPrecompactChain(entries, latestUuid, selectedLeafUuid, "full");
  const boundaryPlan = planPrecompactChain(entries, latestUuid, selectedLeafUuid, "boundary");
  return {
    full: { plan: fullPlan, metadata: metadataForPlan(metadata, fullPlan, "full") },
    boundary: {
      plan: boundaryPlan,
      metadata: metadataForPlan(metadata, boundaryPlan, "boundary"),
    },
  };
}

function precompactEntryFromEnvelope(
  envelope: Record<string, unknown>,
  uuid: string,
  offset: number,
): PrecompactChainEntry {
  const isBoundary = envelope.type === "system" && envelope.subtype === "compact_boundary";
  const compactMetadata = normalizedCompactionMetadata(envelope);
  return {
    uuid,
    offset,
    type: typeof envelope.type === "string" ? envelope.type : "",
    ...(typeof envelope.subtype === "string" ? { subtype: envelope.subtype } : {}),
    parentUuid: typeof envelope.parentUuid === "string" ? envelope.parentUuid : null,
    ...(typeof envelope.logicalParentUuid === "string"
      ? { logicalParentUuid: envelope.logicalParentUuid }
      : {}),
    ...(compactMetadata !== undefined ? { compactMetadata } : {}),
    ...(isBoundary ? { hasCompactionSummary: hasCompactionSummary(envelope) } : {}),
  };
}

function normalizedCompactionMetadata(envelope: Record<string, unknown>): unknown {
  const canonical = objectRecord(envelope.compactMetadata);
  const sidecar = objectRecord(objectRecord(envelope._os)?.compaction);
  const preservedSegment = sidecar?.preservedSegment ?? canonical?.preservedSegment;
  const preservedMessages = sidecar?.preservedMessages ?? canonical?.preservedMessages;
  if (preservedSegment === undefined && preservedMessages === undefined) return undefined;
  return {
    ...(preservedSegment !== undefined ? { preservedSegment } : {}),
    ...(preservedMessages !== undefined ? { preservedMessages } : {}),
  };
}

function hasCompactionSummary(envelope: Record<string, unknown>): boolean {
  const sidecar = objectRecord(objectRecord(envelope._os)?.compaction);
  if (sidecar !== null && "summaryRef" in sidecar) return hasSummaryRef(sidecar.summaryRef);
  if ("summary_ref" in envelope) return hasSummaryRef(envelope.summary_ref);
  if ("summary" in envelope) return hasSummaryRef(envelope.summary);
  const content = envelope.content;
  return (
    typeof content === "string" &&
    content.trim().length > 0 &&
    content.trim() !== "Conversation compacted"
  );
}

function hasSummaryRef(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  const record = objectRecord(value);
  return (
    record?.kind === "spilled_compaction_summary" &&
    typeof record.filepath === "string" &&
    record.filepath.length > 0
  );
}

function renderPlannedLines(
  plan: ReturnType<typeof planPrecompactChain>,
  textByOffset: ReadonlyMap<number, string>,
  metadataOffsets: ReadonlySet<number>,
): string[] {
  const metadata = [...metadataOffsets]
    .sort((a, b) => a - b)
    .flatMap((offset) => {
      const text = textByOffset.get(offset);
      return text === undefined ? [] : [text];
    });
  const chain = plan.ordered.flatMap((entry) => {
    const text = textByOffset.get(entry.offset);
    if (text === undefined) return [];
    return [rewritePlannedLine(text, entry, plan)];
  });
  return [...metadata, ...chain];
}

/** Parallel file-offset list for `renderPlannedLines` output (metadata then chain). */
function plannedLineOffsets(
  plan: ReturnType<typeof planPrecompactChain>,
  textByOffset: ReadonlyMap<number, string>,
  metadataOffsets: ReadonlySet<number>,
): number[] {
  const metadata = [...metadataOffsets]
    .sort((a, b) => a - b)
    .filter((offset) => textByOffset.has(offset));
  const chain = plan.ordered
    .map((entry) => entry.offset)
    .filter((offset) => textByOffset.has(offset));
  return [...metadata, ...chain];
}

function rewritePlannedLine(
  text: string,
  entry: PrecompactChainEntry,
  plan: ReturnType<typeof planPrecompactChain>,
): string {
  const parent = plan.parentOverrides.get(entry.uuid);
  const zeroUsage =
    plan.preserve === "live" &&
    plan.boundaryOffset !== null &&
    entry.offset < plan.boundaryOffset &&
    entry.type === "assistant";
  const neutralizeBrokenBoundary =
    plan.preserve === "broken" && plan.brokenBoundaryUuid === entry.uuid;
  if (parent === undefined && !zeroUsage && !neutralizeBrokenBoundary) return text;
  const envelope = parseLineEnvelope(text);
  if (envelope === null) return text;
  if (parent !== undefined) envelope.parentUuid = parent;
  if (neutralizeBrokenBoundary) clearCompactionSummary(envelope);
  if (zeroUsage) {
    const message = objectRecord(envelope.message);
    const usage = objectRecord(message?.usage);
    if (message !== null && usage !== null) {
      message.usage = {
        ...usage,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }
    const sidecar = objectRecord(envelope._os);
    if (sidecar !== null) delete sidecar.thoughtTokens;
  }
  return JSON.stringify(envelope);
}

function clearCompactionSummary(envelope: Record<string, unknown>): void {
  envelope.content = "";
  if ("summary" in envelope) envelope.summary = "";
  if ("summary_ref" in envelope) envelope.summary_ref = "";
  const compaction = objectRecord(objectRecord(envelope._os)?.compaction);
  if (compaction !== null) delete compaction.summaryRef;
}

function metadataForPlan(
  metadata: TranscriptMetadataOffsets,
  plan: Pick<ReturnType<typeof planPrecompactChain>, "boundaryOffset" | "preserve">,
  scope: "boundary" | "full",
): Set<number> {
  const { boundaryOffset } = plan;
  const selected = new Set<number>();
  for (const offset of metadata.all) {
    if (scope === "full" || boundaryOffset === null || offset >= boundaryOffset) {
      selected.add(offset);
    }
  }
  // An ordinary boundary (no preserved tail) replaces everything before it:
  // an attribution snapshot or last-prompt recorded for that replaced history
  // is stale and must not be restored. Session metadata is recovered across
  // boundaries regardless. A preserve boundary keeps its metadata live.
  const resetAt = plan.preserve === "none" ? boundaryOffset : null;
  const fresh = (offset: number | undefined): offset is number =>
    offset !== undefined && (resetAt === null || offset >= resetAt);
  if (metadata.latestSessionMeta !== undefined) selected.add(metadata.latestSessionMeta);
  if (fresh(metadata.latestLastPrompt)) selected.add(metadata.latestLastPrompt);
  if (fresh(metadata.latestAttribution)) selected.add(metadata.latestAttribution);
  return selected;
}

function isSessionMetaEnvelope(envelope: Record<string, unknown>): boolean {
  if (envelope.type === "session_meta") return true;
  if (envelope.type !== "system") return false;
  return (
    envelope.subtype === "otherside-config" || objectRecord(envelope._os)?.type === "session_meta"
  );
}

function isChainEnvelope(envelope: Record<string, unknown>): boolean {
  if (typeof envelope.type !== "string") return false;
  if (!("_os" in envelope)) return isChainParticipantLine(envelope);
  const recordType = nativeRecordType(envelope._os);
  return recordType === null ? isChainParticipantLine(envelope) : isChainParticipant(recordType);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

async function scanTranscriptLines(
  handle: FileHandle,
  size: number,
  visit: (line: Buffer, offset: number) => void,
  selectedOffsets?: ReadonlySet<number>,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(TRANSCRIPT_SCAN_BUFFER_BYTES);
  let position = 0;
  let lineStart = 0;
  let pending: Buffer[] = [];
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = buffer.indexOf(NEWLINE_BYTE, cursor);
      if (newline === -1 || newline >= bytesRead) {
        pending.push(Buffer.from(buffer.subarray(cursor, bytesRead)));
        break;
      }
      if (selectedOffsets === undefined || selectedOffsets.has(lineStart)) {
        const tail = buffer.subarray(cursor, newline);
        visit(pending.length === 0 ? tail : Buffer.concat([...pending, tail]), lineStart);
      }
      pending = [];
      cursor = newline + 1;
      lineStart = position + cursor;
    }
    position += bytesRead;
  }
  if (pending.length > 0 && (selectedOffsets === undefined || selectedOffsets.has(lineStart))) {
    visit(Buffer.concat(pending), lineStart);
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
  return recordsFromLinesWithOffsets(lines).records;
}

interface OffsetTaggedRecords {
  records: SessionRecord[];
  /** Parallel to each produced record: source line offset (file or synthetic). */
  recordOffsets: number[];
}

function recordsFromLinesWithOffsets(
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
function recordsFromLinesCached(
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

export interface ResumeLoad {
  records: SessionRecord[];
  modelRecords: SessionRecord[];
  usageRecords: UsageRecord[];
  chainHead: string | null;
  cwd: string | null;
  /**
   * Fully-typed tail records for initial transcript projection. Call sites pass
   * this (not the full `records` set) into sessionRecordsToTranscript.
   * Equal to `records` for small transcripts where the whole chain is materialized.
   */
  tailRecords: SessionRecord[];
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
  const path = findSessionPath(id);
  if (path === null) throw new SessionNotFoundError(id);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new SessionNotFoundError(id);
  const projectDirName = basename(dirname(path));
  const size = file.size;

  // Large-file path: materialize full line text only for the tail + boundary,
  // and extract a head summary during the envelope pass for resume consumers.
  if (!precompactSkipDisabled() && size > PRECOMPACT_SKIP_THRESHOLD_BYTES) {
    return loadSessionForResumeLarge(id, path, size, currentCwd, projectDirName);
  }

  const lines = await readResumeChainLines(id);
  // The project directory the transcript actually lives in: relocation
  // (worktree enter/exit, /cd) moves the file without rewriting old lines,
  // so the recorded first-line cwd can be stale.
  await assertResumeCwd(lines.full, currentCwd, projectDirName);
  const chainHead = chainHeadFromLines(lines.full);
  const cwd = resumeStorageCwd(lines.full, currentCwd, projectDirName);
  // Fix 1: parse the full plan once, then derive model/boundary records via a
  // shared line-text cache (rewritten boundary lines re-parse; shared strings do not).
  const lineCache = new Map<string, SessionRecord[]>();
  const { records, usageRecords } = partitionResumeRecords(
    recordsFromLinesCached(lines.full, lineCache),
  );
  const { records: modelRecords } = partitionResumeRecords(
    recordsFromLinesCached(lines.boundary, lineCache),
  );
  return {
    records,
    modelRecords,
    usageRecords,
    chainHead,
    cwd,
    tailRecords: records,
  };
}

interface HeadSummaryBucket {
  offset: number;
  records: SessionRecord[];
}

async function loadSessionForResumeLarge(
  _id: string,
  path: string,
  size: number,
  currentCwd: string,
  projectDirName: string,
): Promise<ResumeLoad> {
  const handle = await open(path, "r");
  try {
    const entries: PrecompactChainEntry[] = [];
    const metadata: TranscriptMetadataOffsets = { all: new Set() };
    const headBuckets: HeadSummaryBucket[] = [];
    let latestUuid: string | undefined;
    let selectedLeafUuid: string | undefined;
    let firstCwd: string | null = null;

    await scanTranscriptLines(handle, size, (line, offset) => {
      const text = line.toString("utf8");
      const envelope = parseLineEnvelope(text);
      if (envelope === null || envelope.isSidechain === true) return;
      if (firstCwd === null && typeof envelope.cwd === "string" && envelope.cwd.length > 0) {
        firstCwd = envelope.cwd;
      }
      if (envelope.type === "attribution-snapshot") {
        metadata.latestAttribution = offset;
        return;
      }
      if (envelope.type === "last-prompt") {
        if (typeof envelope.leafUuid === "string") selectedLeafUuid = envelope.leafUuid;
        metadata.latestLastPrompt = offset;
        return;
      }
      if (isSessionMetaEnvelope(envelope)) {
        metadata.latestSessionMeta = offset;
        // session_meta is always kept in the head summary (latest wins via walk).
        const summary = headSummaryFromEnvelope(envelope);
        if (summary.length > 0) headBuckets.push({ offset, records: summary });
        return;
      }

      const uuid = typeof envelope.uuid === "string" ? envelope.uuid : undefined;
      if (uuid === undefined || !("parentUuid" in envelope) || !isChainEnvelope(envelope)) {
        metadata.all.add(offset);
        const summary = headSummaryFromEnvelope(envelope);
        if (summary.length > 0) headBuckets.push({ offset, records: summary });
        return;
      }
      entries.push(precompactEntryFromEnvelope(envelope, uuid, offset));
      latestUuid = uuid;
      const summary = headSummaryFromEnvelope(envelope);
      if (summary.length > 0) headBuckets.push({ offset, records: summary });
    });

    const plans = plannedChainPlans(entries, metadata, latestUuid, selectedLeafUuid);
    const fullChainOffsets = plans.full.plan.ordered.map((entry) => entry.offset);
    const tailChainOffsets = fullChainOffsets.slice(-resumeTailChainEntries());
    const tailOffsetSet = new Set(tailChainOffsets);
    const boundaryOffsetSet = new Set([
      ...plans.boundary.plan.ordered.map((entry) => entry.offset),
      ...plans.boundary.metadata,
    ]);
    // Materialize full text only for tail + boundary (+ any full metadata that
    // still needs a full parse — session_meta is already summarized).
    const materializeOffsets = new Set<number>([
      ...tailOffsetSet,
      ...boundaryOffsetSet,
      ...[...plans.full.metadata].filter(
        (offset) => !headBuckets.some((bucket) => bucket.offset === offset),
      ),
    ]);
    // Always materialize full-plan metadata that is also in the tail window region.
    for (const offset of plans.full.metadata) {
      if (tailOffsetSet.has(offset) || boundaryOffsetSet.has(offset)) {
        materializeOffsets.add(offset);
      }
    }

    const textByOffset = new Map<number, string>();
    await scanTranscriptLines(
      handle,
      size,
      (line, offset) => {
        const text = line.toString("utf8");
        if (text.trim().length > 0 && isMainChainLine(text)) textByOffset.set(offset, text);
      },
      materializeOffsets,
    );

    const fullTailLines = renderPlannedLines(
      plans.full.plan,
      textByOffset,
      new Set([...plans.full.metadata].filter((offset) => materializeOffsets.has(offset))),
    );
    const fullTailOffsets = plannedLineOffsets(
      plans.full.plan,
      textByOffset,
      new Set([...plans.full.metadata].filter((offset) => materializeOffsets.has(offset))),
    );
    // Restrict chain render to offsets we actually materialized: rewrite drops
    // missing text, so fullTailLines is the typed tail (+ any boundary-overlap
    // preserved entries that fall inside the materialize set).
    const boundaryLines = renderPlannedLines(
      plans.boundary.plan,
      textByOffset,
      plans.boundary.metadata,
    );

    // Materialized lines may include the whole boundary chain (needed for model
    // context) plus the display tail. Keep those concerns separate.
    const taggedMaterialized = recordsFromLinesWithOffsets(fullTailLines, fullTailOffsets);
    const materializedPartition = partitionResumeRecords(taggedMaterialized.records);

    // Head summary: keep only offsets that are on the full plan but not fully typed.
    const fullyTypedOffsets = new Set(taggedMaterialized.recordOffsets);
    const headUsage: UsageRecord[] = [];
    for (const bucket of headBuckets) {
      if (fullyTypedOffsets.has(bucket.offset)) continue;
      // Only keep head summaries for offsets that the full plan selected
      // (dead branches / pre-boundary metadata already filtered by planning for
      // lines, but metadata.all may include more — accept plan membership).
      const onFullPlan =
        plans.full.metadata.has(bucket.offset) ||
        plans.full.plan.ordered.some((entry) => entry.offset === bucket.offset) ||
        metadata.all.has(bucket.offset);
      if (!onFullPlan) continue;
      for (const rec of bucket.records) {
        if (rec.type === "usage") headUsage.push(rec as UsageRecord);
      }
    }

    // Model records always come from the boundary plan lines (correct rewrites).
    // Shared line text with the already-typed materialization hits the cache (fix 1).
    const lineCache = new Map<string, SessionRecord[]>();
    for (let i = 0; i < fullTailLines.length; i += 1) {
      const line = fullTailLines[i];
      if (line === undefined || lineCache.has(line)) continue;
      const offset = fullTailOffsets[i];
      const recs: SessionRecord[] = [];
      for (let j = 0; j < taggedMaterialized.records.length; j += 1) {
        if (taggedMaterialized.recordOffsets[j] === offset) {
          const rec = taggedMaterialized.records[j];
          if (rec !== undefined) recs.push(rec);
        }
      }
      if (recs.length > 0) lineCache.set(line, recs);
    }
    const { records: modelRecords } = partitionResumeRecords(
      recordsFromLinesCached(boundaryLines, lineCache),
    );

    // Display tail: only the last N full-plan chain entries (plus any materialized
    // metadata whose offset falls in that tail window). Boundary-only materialization
    // outside the tail is for modelRecords, not transcript projection.
    const tailRecordList: SessionRecord[] = [];
    const tailUsage: UsageRecord[] = [];
    for (let i = 0; i < taggedMaterialized.records.length; i += 1) {
      const rec = taggedMaterialized.records[i];
      const offset = taggedMaterialized.recordOffsets[i];
      if (rec === undefined || offset === undefined) continue;
      if (!tailOffsetSet.has(offset)) continue;
      if (rec.type === "usage") tailUsage.push(rec as UsageRecord);
      else if (rec.type !== "hook_event") tailRecordList.push(rec);
    }

    // Merge head summary + fully typed materialization in offset order for session.records.
    // Prefer full bodies over head stubs when both exist for the same offset.
    const merged: { offset: number; rec: SessionRecord }[] = [];
    for (const bucket of headBuckets) {
      if (fullyTypedOffsets.has(bucket.offset)) continue;
      for (const rec of bucket.records) {
        if (rec.type === "usage" || rec.type === "hook_event") continue;
        merged.push({ offset: bucket.offset, rec });
      }
    }
    for (let i = 0; i < taggedMaterialized.records.length; i += 1) {
      const rec = taggedMaterialized.records[i];
      const offset = taggedMaterialized.recordOffsets[i];
      if (rec === undefined || offset === undefined) continue;
      if (rec.type === "usage" || rec.type === "hook_event") continue;
      merged.push({ offset, rec });
    }
    merged.sort((a, b) => a.offset - b.offset || 0);
    const records: SessionRecord[] = [];
    const seenKeys = new Set<string>();
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const item = merged[i];
      if (item === undefined) continue;
      const key = `${item.offset}\0${item.rec.type}\0${"uuid" in item.rec ? (item.rec.uuid ?? "") : ""}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      records.push(item.rec);
    }
    records.reverse();

    const usageRecords = [...headUsage, ...tailUsage, ...materializedPartition.usageRecords].filter(
      (rec, index, all) => {
        // De-dupe usage records that appear in both tail and full materialization.
        return (
          all.findIndex(
            (other) =>
              other.ts === rec.ts &&
              other.provider === rec.provider &&
              other.model === rec.model &&
              other.input_tokens === rec.input_tokens &&
              other.output_tokens === rec.output_tokens,
          ) === index
        );
      },
    );

    const syntheticLinesForCwd = firstCwd !== null ? [`{"cwd":${JSON.stringify(firstCwd)}}`] : [];
    await assertResumeCwdFromPersisted(firstCwd, currentCwd, projectDirName);
    const cwd =
      firstCwd !== null && projectSlug(firstCwd) === projectDirName
        ? firstCwd
        : resumeStorageCwd(syntheticLinesForCwd, currentCwd, projectDirName);

    // chain head from planned latest / native scan of materialized tail lines
    const chainHead =
      chainHeadFromLines(fullTailLines) ?? (typeof latestUuid === "string" ? latestUuid : null);

    return {
      records,
      modelRecords,
      usageRecords,
      chainHead,
      cwd,
      tailRecords: tailRecordList,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Head-only fields needed by resume consumers (usage, broker, injections,
 * replacements, compaction marks, worktree stamps). Message bodies are omitted
 * so large pre-tail history is not retained as typed records.
 */
function headSummaryFromEnvelope(envelope: Record<string, unknown>): SessionRecord[] {
  const sidecar = objectRecord(envelope._os);
  if (sidecar !== null && typeof sidecar.type === "string") {
    const type = sidecar.type;
    if (
      type === "usage" ||
      type === "injection_queued" ||
      type === "content_replacement" ||
      type === "worktree_state" ||
      type === "session_meta" ||
      type === "compaction_mark" ||
      type === "attachment" ||
      type === "turn_completion"
    ) {
      return recordsFromParsedLine(envelope);
    }
  }

  if (isSessionMetaEnvelope(envelope)) {
    return recordsFromParsedLine(envelope);
  }
  if (envelope.type === "system" && envelope.subtype === "compact_boundary") {
    return recordsFromParsedLine(envelope);
  }
  if (envelope.type === "attachment") {
    return recordsFromParsedLine(envelope);
  }
  if (envelope.type === "usage") {
    return recordsFromParsedLine(envelope);
  }

  // Lightweight broker / usage stubs for conversation lines (no message body).
  if (envelope.type === "user" || envelope.type === "assistant") {
    return brokerUsageStubsFromEnvelope(envelope, sidecar);
  }
  return [];
}

function brokerUsageStubsFromEnvelope(
  envelope: Record<string, unknown>,
  sidecar: Record<string, unknown> | null,
): SessionRecord[] {
  const ts = typeof envelope.timestamp === "string" ? envelope.timestamp : new Date().toISOString();
  const uuid = typeof envelope.uuid === "string" ? envelope.uuid : undefined;
  const out: SessionRecord[] = [];

  if (envelope.type === "assistant") {
    const message =
      envelope.message && typeof envelope.message === "object"
        ? (envelope.message as Record<string, unknown>)
        : undefined;
    const rawModel = typeof message?.model === "string" ? message.model : undefined;
    const model =
      rawModel && rawModel !== "<synthetic>"
        ? rawModel
        : typeof sidecar?.model === "string"
          ? sidecar.model
          : undefined;
    const provider: ProviderId | undefined = isProviderId(sidecar?.provider)
      ? sidecar.provider
      : undefined;
    const usageRaw = message?.usage;
    const usageObj =
      usageRaw && typeof usageRaw === "object" ? (usageRaw as Record<string, unknown>) : null;
    const thoughtTokens = typeof sidecar?.thoughtTokens === "number" ? sidecar.thoughtTokens : 0;
    const requestCount =
      typeof sidecar?.requestCount === "number" ? sidecar.requestCount : undefined;
    let usage:
      | {
          input_tokens: number;
          output_tokens: number;
          thought_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          request_count: number;
        }
      | undefined;
    if (usageObj !== null || requestCount !== undefined) {
      const stamp = {
        input_tokens: nonNeg(usageObj?.input_tokens),
        output_tokens: nonNeg(usageObj?.output_tokens),
        thought_tokens: nonNeg(thoughtTokens),
        cache_creation_input_tokens: nonNeg(usageObj?.cache_creation_input_tokens),
        cache_read_input_tokens: nonNeg(usageObj?.cache_read_input_tokens),
        request_count: nonNeg(requestCount ?? 0),
      };
      const hasTokens =
        stamp.input_tokens > 0 ||
        stamp.output_tokens > 0 ||
        stamp.thought_tokens > 0 ||
        stamp.cache_creation_input_tokens > 0 ||
        stamp.cache_read_input_tokens > 0;
      if (hasTokens || requestCount !== undefined) usage = stamp;
    }
    if (usage === undefined && provider === undefined && model === undefined) return out;
    out.push({
      type: "assistant_message",
      ts,
      ...(uuid ? { uuid } : {}),
      content: "",
      ...(usage ? { usage } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });
    return out;
  }

  if (envelope.type === "user") {
    const provider: ProviderId | undefined = isProviderId(sidecar?.provider)
      ? sidecar.provider
      : undefined;
    const model = typeof sidecar?.model === "string" ? sidecar.model : undefined;
    const permissionMode =
      typeof envelope.permissionMode === "string" ? envelope.permissionMode : undefined;
    if (provider === undefined && model === undefined && permissionMode === undefined) return out;
    out.push({
      type: "user_message",
      ts,
      ...(uuid ? { uuid } : {}),
      content: "",
      ...(permissionMode ? { permissionMode } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });
  }
  return out;
}

function nonNeg(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function assertResumeCwdFromPersisted(
  persistedCwd: string | null,
  currentCwd: string,
  projectDirName: string,
): Promise<void> {
  if (persistedCwd === null) return;
  const canonicalPersistedCwd = canonicalizeCwd(persistedCwd);
  const filter = await sessionCwdFilterFor(currentCwd);
  if (filter.matchSet.has(persistedCwd) || filter.matchSet.has(canonicalPersistedCwd)) return;
  if (filter.slugSet.has(projectDirName)) return;
  throw new Error(
    `This session belongs to a different directory. Open ${persistedCwd} to resume it.`,
  );
}

async function assertResumeCwd(
  lines: string[],
  currentCwd: string,
  projectDirName: string,
): Promise<void> {
  const persistedCwd = persistedCwdFromLines(lines);
  if (persistedCwd === null) return;
  const canonicalPersistedCwd = canonicalizeCwd(persistedCwd);
  const filter = await sessionCwdFilterFor(currentCwd);
  if (filter.matchSet.has(persistedCwd) || filter.matchSet.has(canonicalPersistedCwd)) return;
  // A relocated transcript belongs to the project directory it now lives in,
  // even when its recorded cwd names a directory that no longer exists (e.g.
  // a removed worktree). Same dual rule as listSessionFiles.
  if (filter.slugSet.has(projectDirName)) return;
  throw new Error(
    `This session belongs to a different directory. Open ${persistedCwd} to resume it.`,
  );
}

/**
 * Storage home for the resumed session. Normally the recorded cwd; for a
 * relocated transcript (its file no longer lives under the recorded cwd's
 * project dir) the current cwd is the new home, so appends keep landing in
 * the file's actual project directory instead of resurrecting the old one.
 */
function resumeStorageCwd(
  lines: string[],
  currentCwd: string,
  projectDirName: string,
): string | null {
  const persistedCwd = persistedCwdFromLines(lines);
  if (persistedCwd !== null && projectSlug(persistedCwd) === projectDirName) return persistedCwd;
  if (projectSlug(currentCwd) === projectDirName) return currentCwd;
  const canonical = canonicalizeCwd(currentCwd);
  if (projectSlug(canonical) === projectDirName) return canonical;
  return persistedCwd;
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
    if (env.subtype === "compact_boundary" && !hasCompactionSummary(env)) continue;
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
