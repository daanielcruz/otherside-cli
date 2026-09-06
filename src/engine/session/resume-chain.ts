import { open } from "node:fs/promises";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { findSessionPath } from "./paths.ts";
import {
  hasCompactionSummary,
  isChainEnvelope,
  isSessionMetaEnvelope,
  objectRecord,
} from "./record-envelope.ts";
import { type PrecompactChainEntry, planPrecompactChain } from "./transcript/precompact-chain.ts";
import { parseLineEnvelope } from "./transcript/truncate.ts";
import {
  isMainChainLine,
  readTranscriptLineRanges,
  scanTranscriptLines,
  selectTranscriptLineRanges,
  streamNonEmptyLines,
  type TranscriptLineRange,
} from "./transcript-lines.ts";

export const PRECOMPACT_SKIP_THRESHOLD_BYTES = 5_242_880;
/** Fully-typed chain entries kept at the end of a large resume load (covers cap+step). */
const DEFAULT_RESUME_TAIL_CHAIN_ENTRIES = 1000;

export function resumeTailChainEntries(): number {
  const raw = process.env.OTHERSIDE_RESUME_TAIL_ENTRIES;
  if (raw === undefined || raw.length === 0) return DEFAULT_RESUME_TAIL_CHAIN_ENTRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RESUME_TAIL_CHAIN_ENTRIES;
}

export function precompactSkipDisabled(): boolean {
  return isEnvTruthy(process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP);
}

export interface TranscriptMetadataOffsets {
  all: Set<number>;
  latestSessionMeta?: number;
  latestLastPrompt?: number;
  latestAttribution?: number;
}

export async function readActiveChainLines(id: string): Promise<string[]> {
  return (await readResumeChainLines(id)).full;
}

export interface ResumeChainLines {
  full: string[];
  boundary: string[];
  /** File offsets for each entry in `full`, parallel to the line array. */
  fullOffsets: number[];
  /** File offsets that belong to the boundary plan (subset of the full plan). */
  boundaryOffsetSet: ReadonlySet<number>;
}

export async function readResumeChainLines(id: string): Promise<ResumeChainLines> {
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
    const lineRanges: TranscriptLineRange[] = [];
    let latestUuid: string | undefined;
    let selectedLeafUuid: string | undefined;

    await scanTranscriptLines(handle, size, (line, offset) => {
      const envelope = parseLineEnvelope(line.toString("utf8"));
      if (envelope === null || envelope.isSidechain === true) return;
      lineRanges.push({ offset, length: line.length });
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
    const selection = selectLargeResumePlanOffsets(plans, metadata, "preview");
    const textByOffset = new Map<number, string>();
    await readTranscriptLineRanges(
      handle,
      selectTranscriptLineRanges(lineRanges, selection.materializeOffsets),
      (line, offset) => {
        const text = line.toString("utf8");
        if (text.trim().length > 0 && isMainChainLine(text)) textByOffset.set(offset, text);
      },
    );
    return {
      full: renderPlannedLines(plans.full.plan, textByOffset, plans.full.metadata),
      boundary: renderPlannedLines(
        plans.boundary.plan,
        textByOffset,
        selection.boundaryMetadataOffsets,
      ),
      fullOffsets: plannedLineOffsets(plans.full.plan, textByOffset, plans.full.metadata),
      boundaryOffsetSet: selection.boundaryOffsetSet,
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

export function plannedChainPlans(
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

interface LargeResumePlanSelection {
  fullChainOffsets: readonly number[];
  tailOffsetSet: ReadonlySet<number>;
  boundaryOffsetSet: ReadonlySet<number>;
  boundaryMetadataOffsets: ReadonlySet<number>;
  materializeOffsets: ReadonlySet<number>;
}

/** What the offsets will feed, which decides whether the chain may be cut short. */
export type ResumeSelectionPurpose = "model-input" | "preview";

/**
 * Offsets a large resume materializes. A preview shows only its last turns, so it may
 * stop at the tail; model input may not. A transcript that never compacted still holds
 * its whole conversation, and cutting there would resume from less history than the
 * session actually has.
 */
export function selectLargeResumePlanOffsets(
  plans: ReturnType<typeof plannedChainPlans>,
  metadata: TranscriptMetadataOffsets,
  purpose: ResumeSelectionPurpose,
): LargeResumePlanSelection {
  const fullChainOffsets = plans.full.plan.ordered.map((entry) => entry.offset);
  const tailChainOffsets = fullChainOffsets.slice(-resumeTailChainEntries());
  const tailOffsetSet = new Set(tailChainOffsets);
  const chainFloor =
    purpose === "preview" && plans.boundary.plan.boundaryOffset === null
      ? (tailChainOffsets[0] ?? 0)
      : 0;
  const recoveredMetadataOffsets = new Set(
    [metadata.latestSessionMeta, metadata.latestLastPrompt, metadata.latestAttribution].filter(
      (offset): offset is number => offset !== undefined,
    ),
  );
  const boundaryMetadataOffsets = new Set(
    [...plans.boundary.metadata].filter(
      (offset) => offset >= chainFloor || recoveredMetadataOffsets.has(offset),
    ),
  );
  const boundaryOffsetSet = new Set([
    ...plans.boundary.plan.ordered
      .map((entry) => entry.offset)
      .filter((offset) => offset >= chainFloor),
    ...boundaryMetadataOffsets,
  ]);
  return {
    fullChainOffsets,
    tailOffsetSet,
    boundaryOffsetSet,
    boundaryMetadataOffsets,
    materializeOffsets: new Set([...tailOffsetSet, ...boundaryOffsetSet, ...plans.full.metadata]),
  };
}

export function precompactEntryFromEnvelope(
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

export function renderPlannedLines(
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
export function plannedLineOffsets(
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
