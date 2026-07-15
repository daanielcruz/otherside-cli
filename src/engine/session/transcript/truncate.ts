import { type FileHandle, open, unlink } from "node:fs/promises";

const BACKWARD_SCAN_CHUNK_BYTES = 256 * 1024;
const FORWARD_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const TITLE_LINE_MAX_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;
const TAIL_SPLICE_CHUNK_BYTES = 4 * 1024 * 1024;

const TITLE_PREFIXES = ['{"type":"ai-title"', '{"type":"custom-title"'] as const;

export function titleLineType(line: string): "ai-title" | "custom-title" | null {
  if (line.startsWith('{"type":"ai-title"')) return "ai-title";
  if (line.startsWith('{"type":"custom-title"')) return "custom-title";
  return null;
}

export function parseLineEnvelope(line: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(line) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface AnchorLine {
  lineStart: number;
  lineEnd: number;
  parentUuid: string | null;
}

const COMPACT_BOUNDARY_NEEDLE = '"subtype":"compact_boundary"';

export function isCompactBoundaryLine(line: string): boolean {
  const env = parseLineEnvelope(line);
  return env !== null && env.subtype === "compact_boundary" && env.isSidechain !== true;
}

export async function findLastActiveBoundaryStart(
  handle: FileHandle,
  fileSize: number,
): Promise<number | null> {
  const needle = Buffer.from(COMPACT_BOUNDARY_NEEDLE, "utf8");
  const overlap = needle.length - 1;
  let pos = fileSize;
  let laterChunkHead: Buffer = Buffer.alloc(0);
  while (pos > 0) {
    const start = Math.max(0, pos - BACKWARD_SCAN_CHUNK_BYTES);
    const chunk = await readRange(handle, { start, end: pos });
    const window = laterChunkHead.length > 0 ? Buffer.concat([chunk, laterChunkHead]) : chunk;
    let idx = window.lastIndexOf(needle);
    while (idx !== -1) {
      if (idx < chunk.length) {
        const line = await readLineAt(handle, { offset: start + idx, fileSize });
        if (line !== null) {
          const env = parseLineEnvelope(line.text);
          if (env && env.subtype === "compact_boundary" && env.isSidechain !== true) {
            return line.start;
          }
        }
      }
      if (idx === 0) break;
      idx = window.lastIndexOf(needle, idx - 1);
    }
    laterChunkHead = chunk.subarray(0, Math.min(overlap, chunk.length));
    pos = start;
  }
  return null;
}

export async function findAnchorLine(
  handle: FileHandle,
  bounds: { fileSize: number; anchorUuid: string },
): Promise<AnchorLine | null> {
  const needle = Buffer.from(`"uuid":"${bounds.anchorUuid}"`, "utf8");
  const overlap = needle.length - 1;
  let pos = bounds.fileSize;
  let laterChunkHead: Buffer = Buffer.alloc(0);
  while (pos > 0) {
    const start = Math.max(0, pos - BACKWARD_SCAN_CHUNK_BYTES);
    const chunk = await readRange(handle, { start, end: pos });
    const window = laterChunkHead.length > 0 ? Buffer.concat([chunk, laterChunkHead]) : chunk;
    let idx = window.lastIndexOf(needle);
    while (idx !== -1) {
      if (idx < chunk.length) {
        const anchor = await verifyAnchorCandidate(handle, {
          matchOffset: start + idx,
          fileSize: bounds.fileSize,
          anchorUuid: bounds.anchorUuid,
        });
        if (anchor !== null) return anchor;
      }
      if (idx === 0) break;
      idx = window.lastIndexOf(needle, idx - 1);
    }
    laterChunkHead = chunk.subarray(0, Math.min(overlap, chunk.length));
    pos = start;
  }
  return null;
}

export async function verifyAnchorCandidate(
  handle: FileHandle,
  candidate: { matchOffset: number; fileSize: number; anchorUuid: string },
): Promise<AnchorLine | null> {
  const line = await readLineAt(handle, {
    offset: candidate.matchOffset,
    fileSize: candidate.fileSize,
  });
  if (line === null) return null;
  const env = parseLineEnvelope(line.text);
  if (!env || env.uuid !== candidate.anchorUuid || env.isSidechain === true) return null;
  return {
    lineStart: line.start,
    lineEnd: line.end,
    parentUuid: typeof env.parentUuid === "string" ? env.parentUuid : null,
  };
}

async function readLineAt(
  handle: FileHandle,
  position: { offset: number; fileSize: number },
): Promise<{ start: number; end: number; text: string } | null> {
  let start = position.offset;
  while (start > 0) {
    const from = Math.max(0, start - BACKWARD_SCAN_CHUNK_BYTES);
    const buf = await readRange(handle, { start: from, end: start });
    const nl = buf.lastIndexOf(NEWLINE_BYTE);
    if (nl !== -1) {
      start = from + nl + 1;
      break;
    }
    start = from;
    if (position.offset - start > MAX_LINE_BYTES) return null;
  }
  let end = position.offset;
  while (end < position.fileSize) {
    const to = Math.min(position.fileSize, end + BACKWARD_SCAN_CHUNK_BYTES);
    const buf = await readRange(handle, { start: end, end: to });
    const nl = buf.indexOf(NEWLINE_BYTE);
    if (nl !== -1) {
      end += nl;
      break;
    }
    end = to;
    if (end - start > MAX_LINE_BYTES) return null;
  }
  if (end - start > MAX_LINE_BYTES) return null;
  const text = (await readRange(handle, { start, end })).toString("utf8");
  return { start, end, text };
}

export async function collectTitleLines(
  handle: FileHandle,
  range: { start: number; end: number },
): Promise<string[]> {
  const lastByPrefix = new Map<string, string>();
  let pending: Buffer | null = Buffer.alloc(0);
  let pos = range.start;
  while (pos < range.end) {
    const to = Math.min(range.end, pos + FORWARD_SCAN_CHUNK_BYTES);
    const chunk = await readRange(handle, { start: pos, end: to });
    let cursor = 0;
    while (cursor < chunk.length) {
      const nl = chunk.indexOf(NEWLINE_BYTE, cursor);
      const slice = chunk.subarray(cursor, nl === -1 ? chunk.length : nl);
      if (pending !== null) {
        pending = pending.length === 0 ? slice : Buffer.concat([pending, slice]);
        if (pending.length > TITLE_LINE_MAX_BYTES || !isTitleCandidate(pending)) pending = null;
      }
      if (nl === -1) break;
      if (pending !== null && pending.length > 0) recordTitleLine(lastByPrefix, pending);
      pending = Buffer.alloc(0);
      cursor = nl + 1;
    }
    pos = to;
  }
  if (pending !== null && pending.length > 0) recordTitleLine(lastByPrefix, pending);
  return [...lastByPrefix.values()];
}

function isTitleCandidate(buf: Buffer): boolean {
  for (const prefix of TITLE_PREFIXES) {
    const cmp = Math.min(buf.length, prefix.length);
    if (buf.toString("utf8", 0, cmp) === prefix.slice(0, cmp)) return true;
  }
  return false;
}

function recordTitleLine(lastByPrefix: Map<string, string>, buf: Buffer): void {
  const line = buf.toString("utf8");
  for (const prefix of TITLE_PREFIXES) {
    if (line.startsWith(prefix)) {
      lastByPrefix.set(prefix, line);
      return;
    }
  }
}

export interface TailSpliceRequest {
  path: string;
  truncateAt: number;
  head: Buffer;
  tailStart: number;
  fileSize: number;
  patchLine?: (line: string) => string;
}

export async function spliceTailStreaming(
  handle: FileHandle,
  request: TailSpliceRequest,
): Promise<void> {
  const tmpPath = `${request.path}.tail.tmp`;
  const writer = Bun.file(tmpPath).writer();
  try {
    if (request.head.length > 0) writer.write(request.head);
    let carry = "";
    let pos = request.tailStart;
    while (pos < request.fileSize) {
      const to = Math.min(request.fileSize, pos + TAIL_SPLICE_CHUNK_BYTES);
      const chunk = (await readRange(handle, { start: pos, end: to })).toString("utf8");
      const combined = carry + chunk;
      const lastNewline = combined.lastIndexOf("\n");
      if (lastNewline === -1) {
        carry = combined;
      } else {
        const complete = combined.slice(0, lastNewline + 1);
        carry = combined.slice(lastNewline + 1);
        writer.write(patchSegment(complete, request.patchLine));
      }
      pos = to;
    }
    if (carry.length > 0) writer.write(patchSegment(carry, request.patchLine));
    await writer.end();

    await handle.truncate(request.truncateAt);
    const tmpHandle = await open(tmpPath, "r");
    try {
      const { size: tmpSize } = await tmpHandle.stat();
      let copied = 0;
      while (copied < tmpSize) {
        const to = Math.min(tmpSize, copied + TAIL_SPLICE_CHUNK_BYTES);
        const buf = await readRange(tmpHandle, { start: copied, end: to });
        await handle.write(buf, 0, buf.length, request.truncateAt + copied);
        copied = to;
      }
    } finally {
      await tmpHandle.close();
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

function patchSegment(segment: string, patchLine: ((line: string) => string) | undefined): string {
  if (!patchLine) return segment;
  const endsWithNewline = segment.endsWith("\n");
  const body = endsWithNewline ? segment.slice(0, -1) : segment;
  const patched = body.split("\n").map(patchLine).join("\n");
  return endsWithNewline ? `${patched}\n` : patched;
}

export async function readRange(
  handle: FileHandle,
  range: { start: number; end: number },
): Promise<Buffer> {
  const length = range.end - range.start;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const r = await handle.read(buffer, done, length - done, range.start + done);
    if (r.bytesRead <= 0) break;
    done += r.bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}
