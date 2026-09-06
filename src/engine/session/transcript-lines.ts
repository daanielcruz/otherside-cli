import { type FileHandle } from "node:fs/promises";
import { findSessionPath } from "./paths.ts";
import { parseLineEnvelope } from "./transcript/truncate.ts";

const TRANSCRIPT_SCAN_BUFFER_BYTES = 1_048_576;
const NEWLINE_BYTE = 0x0a;

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

export async function scanTranscriptLines(
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

/** Byte span of one transcript line, as recorded by a `scanTranscriptLines` pass. */
export interface TranscriptLineRange {
  offset: number;
  length: number;
}

export function selectTranscriptLineRanges(
  ranges: readonly TranscriptLineRange[],
  selectedOffsets: ReadonlySet<number>,
): TranscriptLineRange[] {
  return ranges.filter((range) => selectedOffsets.has(range.offset));
}

/** Neighbouring lines within this gap are fetched by one read. */
const RANGE_COALESCE_GAP_BYTES = 65_536;
/** Upper bound on a single coalesced read, so a dense selection stays paged. */
const RANGE_READ_MAX_BYTES = 8_388_608;

/**
 * Re-reads known line spans instead of streaming the file again. Ranges must be
 * ascending and non-overlapping; adjacent ones are merged into a single read.
 */
export async function readTranscriptLineRanges(
  handle: FileHandle,
  ranges: readonly TranscriptLineRange[],
  visit: (line: Buffer, offset: number) => void,
): Promise<void> {
  let index = 0;
  while (index < ranges.length) {
    const first = ranges[index];
    if (first === undefined) break;
    const start = first.offset;
    let end = start + first.length;
    let next = index + 1;
    while (next < ranges.length) {
      const candidate = ranges[next];
      if (candidate === undefined) break;
      const candidateEnd = candidate.offset + candidate.length;
      if (candidate.offset - end > RANGE_COALESCE_GAP_BYTES) break;
      if (candidateEnd - start > RANGE_READ_MAX_BYTES) break;
      end = candidateEnd;
      next += 1;
    }
    const buffer = Buffer.allocUnsafe(end - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        start + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    for (let i = index; i < next; i += 1) {
      const range = ranges[i];
      if (range === undefined) continue;
      const from = range.offset - start;
      const to = from + range.length;
      if (to > filled) continue;
      visit(buffer.subarray(from, to), range.offset);
    }
    index = next;
  }
}

function keepEveryLine(): boolean {
  return true;
}

export function isMainChainLine(line: string): boolean {
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
