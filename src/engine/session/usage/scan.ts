import { closeSync, openSync, readSync } from "node:fs";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const USAGE_NEEDLE = Buffer.from('"usage"', "utf8");
const NEWLINE_BYTE = 0x0a;

export interface ParsedUsageLine {
  obj: Record<string, unknown>;
  uuid: string | null;
}

export interface UsageScanResult {
  lines: ParsedUsageLine[];
  endOffset: number;
}

export function scanUsageLines(path: string, fromOffset = 0): UsageScanResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { lines: [], endOffset: fromOffset };
  }
  try {
    return scanOpenFile(fd, fromOffset);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function scanOpenFile(fd: number, fromOffset: number): UsageScanResult {
  const lines: ParsedUsageLine[] = [];
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let pending: Buffer = Buffer.alloc(0);
  let position = fromOffset;
  let endOffset = fromOffset;
  while (true) {
    const bytesRead = readSync(fd, chunk, 0, SCAN_CHUNK_BYTES, position);
    if (bytesRead <= 0) break;
    position += bytesRead;
    let cursor = 0;
    while (cursor < bytesRead) {
      const nl = chunk.indexOf(NEWLINE_BYTE, cursor);
      if (nl === -1 || nl >= bytesRead) break;
      const slice = chunk.subarray(cursor, nl);
      const line = pending.length > 0 ? Buffer.concat([pending, slice]) : slice;
      pending = Buffer.alloc(0);
      collectUsageLine(lines, line);
      endOffset += line.length + 1;
      cursor = nl + 1;
    }
    if (cursor < bytesRead) {
      const rest = chunk.subarray(cursor, bytesRead);
      pending = pending.length > 0 ? Buffer.concat([pending, rest]) : Buffer.from(rest);
    }
  }
  return { lines, endOffset };
}

function collectUsageLine(lines: ParsedUsageLine[], raw: Buffer): void {
  if (raw.length === 0 || !raw.includes(USAGE_NEEDLE)) return;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (typeof obj !== "object" || obj === null) return;
  const record = obj as Record<string, unknown>;
  lines.push({ obj: record, uuid: typeof record.uuid === "string" ? record.uuid : null });
}
