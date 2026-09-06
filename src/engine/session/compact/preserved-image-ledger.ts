import { createHash } from "node:crypto";
import type { PreservedImageRef, SessionRecord } from "@/engine/session/record/schema.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export type PreservedImageEntry = ContentBlock | PreservedImageRef;
export type PreservedImageBlock = Extract<ContentBlock, { type: "image" }>;

interface PreservedImageLocation {
  markUuid: string;
  index: number;
}

/**
 * Content hash -> the compaction mark slot that stores that image in full.
 * Every later mark carrying the same image serializes a reference to that slot
 * instead of a second copy of the base64 payload.
 */
export type PreservedImageLedger = Map<string, PreservedImageLocation>;

export function createPreservedImageLedger(): PreservedImageLedger {
  return new Map();
}

export function isPreservedImageBlock(entry: PreservedImageEntry): entry is PreservedImageBlock {
  return entry.type === "image" && entry.source?.type === "base64";
}

function contentHash(block: PreservedImageBlock): string {
  return createHash("sha256").update(block.source.data).digest("hex");
}

function locationKey(markUuid: string, index: number): string {
  return `${markUuid}\u0000${index}`;
}

export function dedupPreservedImagesForWire(
  ledger: PreservedImageLedger,
  markUuid: string | undefined,
  entries: PreservedImageEntry[],
): PreservedImageEntry[] {
  if (markUuid === undefined) return entries;
  return entries.map((entry, index) => {
    if (!isPreservedImageBlock(entry)) return entry;
    const hash = contentHash(entry);
    const stored = ledger.get(hash);
    if (stored !== undefined) {
      return { type: "image_ref", markUuid: stored.markUuid, index: stored.index };
    }
    ledger.set(hash, { markUuid, index });
    return entry;
  });
}

export interface PreservedImageWireRecord {
  record: SessionRecord;
  /** Ledger to adopt once the line is durable; the input ledger is never mutated. */
  ledger: PreservedImageLedger;
}

/** Serialization-ready clone of a compaction mark whose duplicate images became refs. */
export function preservedImagesForWire(
  record: SessionRecord,
  ledger: PreservedImageLedger,
): PreservedImageWireRecord {
  if (record.type !== "compaction_mark" || record.preservedImages === undefined) {
    return { record, ledger };
  }
  const next = new Map(ledger);
  return {
    record: {
      ...record,
      preservedImages: dedupPreservedImagesForWire(next, record.uuid, record.preservedImages),
    },
    ledger: next,
  };
}

interface RegisteredImage {
  location: PreservedImageLocation;
  block: PreservedImageBlock;
}

/**
 * Replaces every wire reference with the full image block it points at, so
 * in-memory compaction marks always carry resolved content. The arrays are
 * walked in the given order against one shared registry, which lets a later
 * array (boundary/tail projections) resolve against marks materialized by an
 * earlier one. Returns the ledger the session continues appending against.
 */
export function hydratePreservedImages(recordArrays: SessionRecord[][]): PreservedImageLedger {
  const registry = new Map<string, RegisteredImage>();
  const hydrated = new Set<SessionRecord>();
  for (const records of recordArrays) {
    for (const record of records) {
      if (record.type !== "compaction_mark" || record.preservedImages === undefined) continue;
      if (hydrated.has(record)) continue;
      hydrated.add(record);
      record.preservedImages = resolvePreservedImages(
        record.preservedImages,
        record.uuid,
        registry,
      );
    }
  }
  return ledgerFromRegistry(registry);
}

function resolvePreservedImages(
  entries: PreservedImageEntry[],
  markUuid: string | undefined,
  registry: Map<string, RegisteredImage>,
): ContentBlock[] {
  const resolved: ContentBlock[] = [];
  entries.forEach((entry, index) => {
    if (entry.type === "image_ref") {
      const registered = registry.get(locationKey(entry.markUuid, entry.index));
      if (registered !== undefined) resolved.push(registered.block);
      return;
    }
    if (markUuid !== undefined && isPreservedImageBlock(entry)) {
      const location = { markUuid, index };
      registry.set(locationKey(markUuid, index), { location, block: entry });
    }
    resolved.push(entry);
  });
  return resolved;
}

function ledgerFromRegistry(registry: Map<string, RegisteredImage>): PreservedImageLedger {
  const ledger = createPreservedImageLedger();
  for (const registered of registry.values()) {
    const hash = contentHash(registered.block);
    if (ledger.has(hash)) continue;
    ledger.set(hash, registered.location);
  }
  return ledger;
}
