import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { canonicalizeCwd, projectSlug } from "@/kernel/std/fs/paths.ts";
import { isProviderId, type ProviderId } from "@/kernel/std/types/provider-ids.ts";
import {
  hydratePreservedImages,
  type PreservedImageLedger,
} from "./compact/preserved-image-ledger.ts";
import { findSessionPath, sessionCwdFilterFor } from "./paths.ts";
import { recordsFromParsedLine, type SessionRecord, type UsageRecord } from "./record/index.ts";
import { isChainEnvelope, isSessionMetaEnvelope, objectRecord } from "./record-envelope.ts";
import {
  chainHeadFromLines,
  recordsFromLinesCached,
  recordsFromLinesWithOffsets,
} from "./record-lines.ts";
import { aggregateDiscardedHistory } from "./resume-aggregate.ts";
import {
  PRECOMPACT_SKIP_THRESHOLD_BYTES,
  plannedChainPlans,
  plannedLineOffsets,
  precompactEntryFromEnvelope,
  precompactSkipDisabled,
  readResumeChainLines,
  renderPlannedLines,
  selectLargeResumePlanOffsets,
  type TranscriptMetadataOffsets,
} from "./resume-chain.ts";
import type { PrecompactChainEntry } from "./transcript/precompact-chain.ts";
import { parseLineEnvelope } from "./transcript/truncate.ts";
import {
  isMainChainLine,
  readTranscriptLineRanges,
  scanTranscriptLines,
  selectTranscriptLineRanges,
  type TranscriptLineRange,
} from "./transcript-lines.ts";

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
  /**
   * True when `records` is a reduced view of the file: the large-transcript path
   * keeps bodyless stubs for history it did not materialize. Anything that would
   * write `records` back over the transcript must refuse while this holds, or the
   * rewrite replaces real turns with the summaries that stood in for them.
   */
  recordsArePartial: boolean;
  /**
   * Seed for the session's preserved-image ledger, rebuilt from the loaded
   * marks. Absent only where no session was loaded at all.
   */
  preservedImageLedger?: PreservedImageLedger;
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
      // Hook events are session-live diagnostics; durable goal state is an attachment.
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
  // Parse the full plan once; rewritten boundary lines alone need a second parse.
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
    recordsArePartial: false,
    preservedImageLedger: hydratePreservedImages([records, modelRecords]),
  };
}

interface HeadSummaryBucket {
  offset: number;
  records: SessionRecord[];
}

/**
 * The envelope pass allocates a transient parse tree per line and keeps almost
 * none of it, but the collector never runs inside the tight scan loop, so
 * committed pages grow with file size. Paced synchronous collection bounds
 * that growth (measured ~13% lower true peak on a ~150MB transcript for ~10ms).
 */
const SCAN_COLLECT_BUDGET_BYTES = 8_388_608;

function pacedScanCollector(): (line: Buffer) => void {
  let pending = 0;
  return (line) => {
    pending += line.length;
    if (pending < SCAN_COLLECT_BUDGET_BYTES) return;
    pending = 0;
    Bun.gc(true);
  };
}

async function loadSessionForResumeLarge(
  id: string,
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

    // Byte spans of every candidate line, so selected lines are re-read by position.
    const lineRanges: TranscriptLineRange[] = [];

    const collect = pacedScanCollector();
    await scanTranscriptLines(handle, size, (line, offset) => {
      collect(line);
      const text = line.toString("utf8");
      const envelope = parseLineEnvelope(text);
      if (envelope === null || envelope.isSidechain === true) return;
      lineRanges.push({ offset, length: line.length });
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
    const selection = selectLargeResumePlanOffsets(plans, metadata, "model-input");
    const { fullChainOffsets, tailOffsetSet, boundaryOffsetSet } = selection;
    // Materialize full text only for tail + boundary (+ any full metadata that
    // still needs a full parse — session_meta is already summarized).
    const headBucketOffsets = new Set(headBuckets.map((bucket) => bucket.offset));
    const materializeOffsets = new Set(
      [...selection.materializeOffsets].filter(
        (offset) =>
          !headBucketOffsets.has(offset) ||
          tailOffsetSet.has(offset) ||
          boundaryOffsetSet.has(offset),
      ),
    );

    const textByOffset = new Map<number, string>();
    await readTranscriptLineRanges(
      handle,
      selectTranscriptLineRanges(lineRanges, materializeOffsets),
      (line, offset) => {
        const text = line.toString("utf8");
        if (text.trim().length > 0 && isMainChainLine(text)) textByOffset.set(offset, text);
      },
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
      selection.boundaryMetadataOffsets,
    );

    // Materialized lines may include the whole boundary chain (needed for model
    // context) plus the display tail. Keep those concerns separate.
    const taggedMaterialized = recordsFromLinesWithOffsets(fullTailLines, fullTailOffsets);
    const materializedPartition = partitionResumeRecords(taggedMaterialized.records);

    // Head summary: keep only offsets that are on the full plan but not fully typed.
    const fullyTypedOffsets = new Set(taggedMaterialized.recordOffsets);
    const fullPlanOffsetSet = new Set(fullChainOffsets);
    const headUsage: UsageRecord[] = [];
    for (const bucket of headBuckets) {
      if (fullyTypedOffsets.has(bucket.offset)) continue;
      // Only keep head summaries for offsets that the full plan selected
      // (dead branches / pre-boundary metadata already filtered by planning for
      // lines, but metadata.all may include more — accept plan membership).
      const onFullPlan =
        plans.full.metadata.has(bucket.offset) ||
        fullPlanOffsetSet.has(bucket.offset) ||
        metadata.all.has(bucket.offset);
      if (!onFullPlan) continue;
      for (const rec of bucket.records) {
        if (rec.type === "usage") headUsage.push(rec as UsageRecord);
      }
    }

    // Model records always come from the boundary plan lines (correct rewrites).
    // Shared line text with the typed materialization reuses the parse cache.
    const recordsByOffset = new Map<number, SessionRecord[]>();
    for (let j = 0; j < taggedMaterialized.records.length; j += 1) {
      const rec = taggedMaterialized.records[j];
      const offset = taggedMaterialized.recordOffsets[j];
      if (rec === undefined || offset === undefined) continue;
      const bucket = recordsByOffset.get(offset);
      if (bucket === undefined) recordsByOffset.set(offset, [rec]);
      else bucket.push(rec);
    }
    const lineCache = new Map<string, SessionRecord[]>();
    for (let i = 0; i < fullTailLines.length; i += 1) {
      const line = fullTailLines[i];
      if (line === undefined || lineCache.has(line)) continue;
      const offset = fullTailOffsets[i];
      const recs = offset === undefined ? undefined : recordsByOffset.get(offset);
      if (recs !== undefined && recs.length > 0) lineCache.set(line, recs);
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
    // History behind the tail collapses to a few aggregate records. They take the
    // offset of the last line they stand for, so they sort where that history
    // ended rather than drifting ahead of the tail that follows it.
    const merged: { offset: number; rec: SessionRecord }[] = [];
    const discardedMessages: SessionRecord[] = [];
    let lastDiscardedOffset = 0;
    for (const bucket of headBuckets) {
      if (fullyTypedOffsets.has(bucket.offset)) continue;
      for (const rec of bucket.records) {
        if (rec.type === "usage" || rec.type === "hook_event") continue;
        if (rec.type === "user_message" || rec.type === "assistant_message") {
          discardedMessages.push(rec);
          lastDiscardedOffset = bucket.offset;
          continue;
        }
        merged.push({ offset: bucket.offset, rec });
      }
    }
    for (const rec of aggregateDiscardedHistory(discardedMessages, id).records) {
      merged.push({ offset: lastDiscardedOffset, rec });
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

    // De-dupe usage records that appear in both tail and full materialization.
    const usageRecords: UsageRecord[] = [];
    const seenUsageKeys = new Set<string>();
    for (const rec of [...headUsage, ...tailUsage, ...materializedPartition.usageRecords]) {
      const key = `${rec.ts}\0${rec.provider}\0${rec.model}\0${rec.input_tokens}\0${rec.output_tokens}`;
      if (seenUsageKeys.has(key)) continue;
      seenUsageKeys.add(key);
      usageRecords.push(rec);
    }

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
      recordsArePartial: true,
      // `records` first: the head summary keeps every compaction mark fully
      // typed, so references held by later projections resolve against it.
      preservedImageLedger: hydratePreservedImages([records, modelRecords, tailRecordList]),
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
      type === "injection_dequeued" ||
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
