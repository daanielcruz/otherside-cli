import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord } from "@/engine/session/append.ts";
import {
  createPreservedImageLedger,
  hydratePreservedImages,
  type PreservedImageEntry,
  type PreservedImageLedger,
  preservedImagesForWire,
} from "@/engine/session/compact/preserved-image-ledger.ts";
import { sessionPathForCwd } from "@/engine/session/paths.ts";
import {
  type CompactionMarkRecord,
  lineToRecord,
  Session,
  SessionChain,
  type SessionRecord,
  type SessionStamp,
  serializeRecord,
} from "@/engine/session/record/index.ts";

const TS = "2024-01-01T00:00:00.000Z";
const STAMP: SessionStamp = { sessionId: "preserved-images", cwd: "/repo", version: "test" };
const ALPHA = "alpha-image-payload";
const BETA = "beta-image-payload";

function imageBlock(data: string): PreservedImageEntry {
  return { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

function mark(uuid: string, preservedImages: PreservedImageEntry[]): CompactionMarkRecord {
  return { type: "compaction_mark", ts: TS, uuid, summary_ref: "summary", preservedImages };
}

function preservedImagesOf(record: SessionRecord | undefined): PreservedImageEntry[] {
  if (record?.type !== "compaction_mark") throw new Error("expected a compaction mark");
  return record.preservedImages ?? [];
}

function serializeWithDedup(records: SessionRecord[]): string[] {
  const chain = new SessionChain();
  let ledger = createPreservedImageLedger();
  return records.map((record) => {
    const wire = preservedImagesForWire(record, ledger);
    ledger = wire.ledger;
    return serializeRecord(wire.record, chain, STAMP);
  });
}

function serializeVerbatim(records: SessionRecord[]): string[] {
  const chain = new SessionChain();
  return records.map((record) => serializeRecord(record, chain, STAMP));
}

function readLines(lines: string[]): SessionRecord[] {
  return lines.map((line) => {
    const record = lineToRecord(line);
    if (record === null) throw new Error("line did not parse into a record");
    return record;
  });
}

function wireImages(record: SessionRecord, ledger: PreservedImageLedger): PreservedImageEntry[] {
  return preservedImagesOf(preservedImagesForWire(record, ledger).record);
}

describe("preserved image wire dedup", () => {
  it("references the first mark that stored an image and keeps new images full", () => {
    const ledger = createPreservedImageLedger();
    const first = preservedImagesForWire(mark("mark-1", [imageBlock(ALPHA)]), ledger);
    const second = preservedImagesForWire(
      mark("mark-2", [imageBlock(ALPHA), imageBlock(BETA)]),
      first.ledger,
    );

    expect(preservedImagesOf(first.record)).toEqual([imageBlock(ALPHA)]);
    expect(preservedImagesOf(second.record)).toEqual([
      { type: "image_ref", markUuid: "mark-1", index: 0 },
      imageBlock(BETA),
    ]);
  });

  it("leaves a mark without a uuid untouched", () => {
    const uuidless: CompactionMarkRecord = {
      type: "compaction_mark",
      ts: TS,
      summary_ref: "summary",
      preservedImages: [imageBlock(ALPHA)],
    };
    const ledger = createPreservedImageLedger();

    expect(wireImages(uuidless, ledger)).toEqual([imageBlock(ALPHA)]);
    expect(ledger.size).toBe(0);
  });
});

describe("preserved image hydration", () => {
  it("round-trips references back to the shared full block", () => {
    const originals = [
      mark("mark-1", [imageBlock(ALPHA)]),
      mark("mark-2", [imageBlock(ALPHA), imageBlock(BETA)]),
    ];
    const lines = serializeWithDedup(originals);
    expect(lines[1]).not.toContain(ALPHA);

    const records = readLines(lines);
    hydratePreservedImages([records]);

    expect(records.map(preservedImagesOf)).toEqual(originals.map(preservedImagesOf));
    expect(preservedImagesOf(records[1])[0]).toBe(preservedImagesOf(records[0])[0]);
  });

  it("resolves references held by a later array against marks from an earlier one", () => {
    const lines = serializeWithDedup([
      mark("mark-1", [imageBlock(ALPHA)]),
      mark("mark-2", [imageBlock(BETA)]),
      mark("mark-3", [imageBlock(ALPHA), imageBlock(BETA)]),
    ]);
    const records = readLines(lines);
    const modelRecords = readLines(lines.slice(2));

    hydratePreservedImages([records, modelRecords]);

    expect(preservedImagesOf(modelRecords[0])).toEqual([imageBlock(ALPHA), imageBlock(BETA)]);
    expect(preservedImagesOf(modelRecords[0])[0]).toBe(preservedImagesOf(records[0])[0]);
  });

  it("drops references that cannot be resolved", () => {
    const orphaned = mark("mark-1", [
      { type: "image_ref", markUuid: "mark-missing", index: 3 },
      imageBlock(BETA),
    ]);

    expect(() => hydratePreservedImages([[orphaned]])).not.toThrow();
    expect(preservedImagesOf(orphaned)).toEqual([imageBlock(BETA)]);
  });

  it("leaves legacy full duplicates unchanged and rebuilds a ledger from the first copy", () => {
    const legacy = [mark("mark-1", [imageBlock(ALPHA)]), mark("mark-2", [imageBlock(ALPHA)])];
    const records = readLines(serializeVerbatim(legacy));

    const ledger = hydratePreservedImages([records]);

    expect(records.map(preservedImagesOf)).toEqual(legacy.map(preservedImagesOf));
    expect(ledger.size).toBe(1);
    expect(wireImages(mark("mark-3", [imageBlock(ALPHA)]), ledger)).toEqual([
      { type: "image_ref", markUuid: "mark-1", index: 0 },
    ]);
  });

  it("seeds a ledger that keeps appending references after a reload", () => {
    const records = readLines(
      serializeWithDedup([
        mark("mark-1", [imageBlock(ALPHA)]),
        mark("mark-2", [imageBlock(ALPHA), imageBlock(BETA)]),
      ]),
    );

    const ledger = hydratePreservedImages([records]);

    expect(wireImages(mark("mark-3", [imageBlock(BETA), imageBlock(ALPHA)]), ledger)).toEqual([
      { type: "image_ref", markUuid: "mark-2", index: 1 },
      { type: "image_ref", markUuid: "mark-1", index: 0 },
    ]);
  });
});

describe("appending compaction marks that preserve images", () => {
  let base: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "otherside-preserved-images-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(base, { recursive: true, force: true });
  });

  it("persists the payload once while every in-memory mark keeps the full block", async () => {
    const session = new Session("preserved-images-append", base);
    await appendRecord(session, {
      type: "compaction_mark",
      ts: TS,
      summary_ref: "first summary",
      preservedImages: [imageBlock(ALPHA)],
    });
    await appendRecord(session, {
      type: "compaction_mark",
      ts: TS,
      summary_ref: "second summary",
      preservedImages: [imageBlock(ALPHA), imageBlock(BETA)],
    });

    const written = readFileSync(sessionPathForCwd(session.storageCwd, session.id), "utf8")
      .trim()
      .split("\n");
    const firstMark = session.records[0];
    if (firstMark?.type !== "compaction_mark" || firstMark.uuid === undefined) {
      throw new Error("expected a persisted compaction mark");
    }
    expect(written[1]).not.toContain(ALPHA);
    expect(session.records.map(preservedImagesOf)).toEqual([
      [imageBlock(ALPHA)],
      [imageBlock(ALPHA), imageBlock(BETA)],
    ]);

    const reloaded = readLines(written);
    expect(preservedImagesOf(reloaded[1])).toEqual([
      { type: "image_ref", markUuid: firstMark.uuid, index: 0 },
      imageBlock(BETA),
    ]);

    hydratePreservedImages([reloaded]);
    expect(preservedImagesOf(reloaded[1])).toEqual([imageBlock(ALPHA), imageBlock(BETA)]);
    expect(preservedImagesOf(reloaded[1])[0]).toBe(preservedImagesOf(reloaded[0])[0]);
  });
});
