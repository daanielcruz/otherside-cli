import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpillBuffer } from "../spill-buffer.ts";

const dirs: string[] = [];

function makeBuffer(tailLimit?: number): SpillBuffer {
  const dir = mkdtempSync(join(tmpdir(), "spill-test-"));
  dirs.push(dir);
  return new SpillBuffer({
    path: join(dir, "stream.spill"),
    ...(tailLimit !== undefined ? { tailLimit } : {}),
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Mirror of the streaming drain's final shape: head = first headChars units
// (shrunk off a split pair), tail = last tailChars units (widened to keep the
// pair together), discarded = utf8 bytes of the middle.
function referenceParts(
  full: string,
  headChars: number,
  tailChars: number,
): { head: string; tail: string; discardedBytes: number; truncated: boolean } {
  if (full.length <= headChars * 2) {
    return { head: full, tail: "", discardedBytes: 0, truncated: false };
  }
  let splitIndex = headChars;
  if (isHighSurrogate(full.charCodeAt(splitIndex - 1))) splitIndex--;
  const head = full.slice(0, splitIndex);
  let tailStart = full.length - tailChars;
  if (isHighSurrogate(full.charCodeAt(tailStart - 1))) tailStart--;
  const tail = full.slice(tailStart);
  const discardedBytes = Buffer.byteLength(full.slice(splitIndex, tailStart), "utf8");
  return { head, tail, discardedBytes, truncated: true };
}

function fillInChunks(buffer: SpillBuffer, full: string, chunkSize: number): void {
  for (let at = 0; at < full.length; at += chunkSize) {
    buffer.append(full.slice(at, at + chunkSize));
  }
}

describe("SpillBuffer.boundedSnapshot", () => {
  it("returns full content untruncated below the threshold", () => {
    const buffer = makeBuffer();
    buffer.append("hello world");
    expect(buffer.boundedSnapshot(100, 50)).toEqual({
      head: "hello world",
      tail: "",
      discardedBytes: 0,
      truncated: false,
    });
    buffer.dispose();
  });

  it("reports head, tail, discardedBytes, and truncated for in-memory content", () => {
    const buffer = makeBuffer();
    const full = "line-".repeat(200); // 1000 chars, no spill (default tail limit)
    fillInChunks(buffer, full, 37);
    expect(buffer.boundedSnapshot(100, 50)).toEqual(referenceParts(full, 100, 50));
    buffer.dispose();
  });

  it("reports head, tail, discardedBytes, and truncated when the head lives on disk", () => {
    const buffer = makeBuffer(64);
    const pieces: string[] = [];
    for (let i = 0; i < 500; i++) pieces.push(`chunk ${i} payload\n`);
    const full = pieces.join("");
    fillInChunks(buffer, full, 53);
    expect(buffer.length).toBe(full.length);
    const parts = buffer.boundedSnapshot(100, 50);
    expect(parts).toEqual(referenceParts(full, 100, 50));
    buffer.dispose();
  });

  it("reports head, tail, discardedBytes, and truncated when the tail spans disk and memory", () => {
    const buffer = makeBuffer(16);
    const full = Array.from({ length: 300 }, (_, i) => `x${i}`).join("|");
    fillInChunks(buffer, full, 7);
    // tailChars far above the 16-unit memory tail forces a disk-backed suffix.
    const parts = buffer.boundedSnapshot(50, 200);
    expect(parts).toEqual(referenceParts(full, 50, 200));
    buffer.dispose();
  });

  it("never splits astral pairs at either boundary", () => {
    const buffer = makeBuffer(32);
    const full = "🙂".repeat(400); // 800 units
    fillInChunks(buffer, full, 11);
    const parts = buffer.boundedSnapshot(101, 51); // odd cuts land mid-pair
    expect(parts).toEqual(referenceParts(full, 101, 51));
    for (const text of [parts.head, parts.tail]) {
      expect(text).toBe(Array.from(text).join(""));
      expect(isHighSurrogate(text.charCodeAt(text.length - 1))).toBe(false);
    }
    buffer.dispose();
  });

  it("accounts discarded bytes for multi-byte content", () => {
    const buffer = makeBuffer(64);
    const full = "áéíóú".repeat(300); // 1500 units, 2 utf8 bytes each
    fillInChunks(buffer, full, 41);
    const parts = buffer.boundedSnapshot(80, 40);
    expect(parts).toEqual(referenceParts(full, 80, 40));
    expect(parts.discardedBytes).toBe(
      Buffer.byteLength(full, "utf8") -
        Buffer.byteLength(parts.head, "utf8") -
        Buffer.byteLength(parts.tail, "utf8"),
    );
    buffer.dispose();
  });

  it("reads a bounded byte window from disk, not the whole spill file", () => {
    const buffer = makeBuffer(128);
    fillInChunks(buffer, "a".repeat(1_000_000), 4096);
    const parts = buffer.boundedSnapshot(100, 50);
    expect(parts.head).toBe("a".repeat(100));
    expect(parts.tail).toBe("a".repeat(50));
    expect(parts.discardedBytes).toBe(1_000_000 - 150);
    buffer.dispose();
  });

  it("bounds readFrom to the retained suffix of a large unread range", () => {
    const buffer = makeBuffer(128);
    fillInChunks(buffer, `${"a".repeat(1_000_000)}THE_END`, 4096);
    expect(buffer.readFrom(0, 50)).toBe(`${"a".repeat(43)}THE_END`);
    buffer.dispose();
  });

  it("does not start a bounded readFrom suffix with a low surrogate", () => {
    const buffer = makeBuffer(16);
    fillInChunks(buffer, `X🙂${"b".repeat(49)}`, 7);
    const out = buffer.readFrom(0, 50);
    expect(out).toBe("b".repeat(49));
    expect(isHighSurrogate(out.charCodeAt(out.length - 1))).toBe(false);
    buffer.dispose();
  });

  it("dispose removes the spill file", () => {
    const buffer = makeBuffer(16);
    buffer.append("spill-me ".repeat(50));
    const dir = dirs[dirs.length - 1];
    if (dir === undefined) throw new Error("missing temp dir");
    const path = join(dir, "stream.spill");
    expect(existsSync(path)).toBe(true);
    buffer.dispose();
    expect(existsSync(path)).toBe(false);
  });
});
