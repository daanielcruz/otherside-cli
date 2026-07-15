import { closeSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_TAIL_CHARS = 256 * 1024;

const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

export interface OutputProgress {
  tailText: string;
  spilledChars: number;
  spilledNewlines: number;
}

export interface SnapshotParts {
  head: string;
  tail: string;
  discardedBytes: number;
  truncated: boolean;
}

// UTF-8 encodes one UTF-16 code unit in at most 3 bytes (astral pairs are
// 4 bytes for 2 units), so 3·chars + 4 bytes always decode to ≥ chars units.
const MAX_UTF8_BYTES_PER_CHAR = 3;

interface SpillCheckpoint {
  char: number;
  byte: number;
}

const LIVE_BUFFERS = new Set<SpillBuffer>();
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    for (const buffer of [...LIVE_BUFFERS]) buffer.dispose();
  });
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function countNewlines(text: string): number {
  let count = 0;
  let at = text.indexOf("\n");
  while (at !== -1) {
    count++;
    at = text.indexOf("\n", at + 1);
  }
  return count;
}

export class SpillBuffer {
  private tail = "";
  private tailStart = 0;
  private spilledBytes = 0;
  private spilledNewlineCount = 0;
  private checkpoints: SpillCheckpoint[] = [];
  private fd: number | null = null;
  private disposed = false;
  private diskFailed = false;
  private readonly path: string;
  private readonly tailLimit: number;

  constructor(opts: { path: string; tailLimit?: number }) {
    this.path = opts.path;
    this.tailLimit = opts.tailLimit ?? DEFAULT_TAIL_CHARS;
    LIVE_BUFFERS.add(this);
    registerExitCleanup();
  }

  get length(): number {
    return this.tailStart + this.tail.length;
  }

  append(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    this.tail += chunk;
    this.spillOverflow();
  }

  readFrom(offset: number, maxChars?: number): string {
    const start = Math.min(Math.max(0, offset), this.length);
    const limit =
      maxChars === undefined || !Number.isFinite(maxChars)
        ? null
        : Math.max(0, Math.floor(maxChars));
    if (limit !== null) {
      if (limit === 0) return "";
      if (this.length - start > limit) return this.readTailCharsWithinLimit(limit);
    }
    if (start >= this.tailStart) return this.tail.slice(start - this.tailStart);
    return this.readSpilledFrom(start) + this.tail;
  }

  snapshot(): string {
    if (this.tailStart === 0) return this.tail;
    return this.readSpilledFrom(0) + this.tail;
  }

  // Bounded exit-time read: at most headChars + tailChars code units plus a
  // byte-bounded disk read — never the whole spill file. Truncation triggers
  // past headChars*2 total units, mirroring the streaming drain's split point
  // so both paths produce identical output for identical content.
  boundedSnapshot(headChars: number, tailChars: number): SnapshotParts {
    if (this.length <= headChars * 2) {
      return { head: this.snapshot(), tail: "", discardedBytes: 0, truncated: false };
    }
    let head = this.readHeadChars(headChars);
    if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
    let tail = this.readTailChars(tailChars);
    if (isLowSurrogate(tail.charCodeAt(0))) {
      const widened = this.readTailChars(tailChars + 1);
      tail = isHighSurrogate(widened.charCodeAt(0)) ? widened : tail.slice(1);
    }
    const totalBytes = this.spilledBytes + Buffer.byteLength(this.tail, "utf8");
    const discardedBytes = Math.max(
      0,
      totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
    );
    return { head, tail, discardedBytes, truncated: true };
  }

  private readHeadChars(count: number): string {
    const end = Math.min(count, this.length);
    if (this.tailStart === 0) return this.tail.slice(0, end);
    if (end <= this.tailStart) {
      const bytes = this.readBytesRange(0, end * MAX_UTF8_BYTES_PER_CHAR + 4);
      return new TextDecoder().decode(bytes).slice(0, end);
    }
    return this.readSpilledFrom(0) + this.tail.slice(0, end - this.tailStart);
  }

  private readTailChars(count: number): string {
    if (count >= this.length) return this.snapshot();
    if (count <= this.tail.length) return this.tail.slice(this.tail.length - count);
    const missing = count - this.tail.length;
    const want = Math.min(this.spilledBytes, missing * MAX_UTF8_BYTES_PER_CHAR + 4);
    const bytes = this.readBytesRange(this.spilledBytes - want, want);
    // The window may open mid-sequence; taking the decoded suffix keeps only
    // fully-decoded units (the read ends at the spill boundary, which is valid).
    const spilledPart = new TextDecoder().decode(bytes).slice(-missing);
    return spilledPart + this.tail;
  }

  private readTailCharsWithinLimit(count: number): string {
    const tail = this.readTailChars(count);
    return isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
  }

  memoryTail(): string {
    return this.tail;
  }

  progress(): OutputProgress {
    return {
      tailText: this.tail,
      spilledChars: this.tailStart,
      spilledNewlines: this.spilledNewlineCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    LIVE_BUFFERS.delete(this);
    this.tail = "";
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {}
    this.fd = null;
    try {
      unlinkSync(this.path);
    } catch {}
  }

  private spillOverflow(): void {
    if (this.diskFailed) return;
    if (this.tail.length <= this.tailLimit) return;
    let cut = this.tail.length - this.tailLimit;
    if (isLowSurrogate(this.tail.charCodeAt(cut))) cut -= 1;
    if (cut <= 0) return;
    const overflow = this.tail.slice(0, cut);
    if (!this.writeToDisk(overflow)) {
      this.diskFailed = true;
      return;
    }
    this.tailStart += cut;
    this.tail = this.tail.slice(cut);
  }

  private writeToDisk(text: string): boolean {
    const data = Buffer.from(text, "utf8");
    try {
      if (this.fd === null) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, "a");
      }
      let written = 0;
      while (written < data.length) {
        written += writeSync(this.fd, data, written, data.length - written);
      }
    } catch {
      return false;
    }
    this.checkpoints.push({ char: this.tailStart, byte: this.spilledBytes });
    this.spilledBytes += data.length;
    this.spilledNewlineCount += countNewlines(text);
    return true;
  }

  private readSpilledFrom(charOffset: number): string {
    const checkpoint = this.checkpointAtOrBefore(charOffset);
    if (checkpoint === null) return "";
    const bytes = this.readBytesFrom(checkpoint.byte);
    const text = new TextDecoder().decode(bytes);
    return text.slice(charOffset - checkpoint.char);
  }

  private checkpointAtOrBefore(charOffset: number): SpillCheckpoint | null {
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    let best: SpillCheckpoint | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = this.checkpoints[mid];
      if (candidate === undefined) break;
      if (candidate.char <= charOffset) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  private readBytesFrom(byteOffset: number): Uint8Array {
    return this.readBytesRange(byteOffset, this.spilledBytes - byteOffset);
  }

  private readBytesRange(byteOffset: number, byteCount: number): Uint8Array {
    const want = Math.min(byteCount, this.spilledBytes - byteOffset);
    if (want <= 0) return new Uint8Array(0);
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return new Uint8Array(0);
    }
    const out = Buffer.alloc(want);
    let total = 0;
    try {
      while (total < want) {
        const n = readSync(fd, out, total, want - total, byteOffset + total);
        if (n <= 0) break;
        total += n;
      }
    } catch {
    } finally {
      try {
        closeSync(fd);
      } catch {}
    }
    return out.subarray(0, total);
  }
}
