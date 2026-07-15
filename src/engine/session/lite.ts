import { open } from "node:fs/promises";

export const LITE_READ_BYTES = 16 * 1024;

export interface SessionLite {
  head: string;
  tail: string;
}

export interface SessionLiteRequest {
  path: string;
  sizeBytes: number;
  buffer: Buffer;
}

export async function readSessionLite(request: SessionLiteRequest): Promise<SessionLite | null> {
  try {
    const handle = await open(request.path, "r");
    try {
      const headLength = Math.min(LITE_READ_BYTES, request.buffer.length);
      const headRead = await handle.read(request.buffer, 0, headLength, 0);
      const head = request.buffer.toString("utf8", 0, headRead.bytesRead);
      const tailOffset = Math.max(0, request.sizeBytes - LITE_READ_BYTES);
      if (tailOffset === 0) return { head, tail: head };
      const tailRead = await handle.read(request.buffer, 0, headLength, tailOffset);
      return { head, tail: request.buffer.toString("utf8", 0, tailRead.bytesRead) };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
