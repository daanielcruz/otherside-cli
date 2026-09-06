import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { devtoolPath } from "@/devtools/settings.ts";

export const MAGIC = Buffer.from("OSCRAW01", "ascii");
export type CodexRawRequestRole = "memory_recall" | "title";
let connectionSerial = 0;
let streamSerial = 0;
let recordSerial = 0;
const startedAt = Date.now();
const previousFrameAt = new Map<string, number>();
const previousLifecycleAt = new Map<string, number>();

export interface CodexRawFrameContext {
  connectionId: string;
  streamId: string;
  sessionId: string;
  requestId?: string;
  turnId?: string;
  agentId?: string;
  subagentLabel?: string;
  isForkChild?: boolean;
  requestRole?: CodexRawRequestRole;
  direction: "inbound" | "outbound";
  isBinary: boolean;
}

export interface CodexRawLifecycleContext {
  connectionId: string;
  sessionId: string;
  streamId?: string;
  requestId?: string;
  turnId?: string;
  agentId?: string;
  agentOwnerId?: string;
  parentThreadId?: string;
  subagentLabel?: string;
  isForkChild?: boolean;
  requestRole?: CodexRawRequestRole;
  socketKey?: string;
  code?: number;
  reason?: string;
}

export type CodexRawLifecycleEvent =
  | "socket_open"
  | "socket_close"
  | "socket_error"
  | "socket_dispose"
  | "stream_start"
  | "stream_end";

export function nextCodexRawConnectionId(): string {
  connectionSerial += 1;
  return `connection-${connectionSerial}`;
}

export function nextCodexRawStreamId(): string {
  streamSerial += 1;
  return `stream-${streamSerial}`;
}

export function recordCodexRawFrame(
  data: string | Buffer | ArrayBuffer | Buffer[],
  context: CodexRawFrameContext,
): void {
  const path = devtoolPath("codexRawStreamCapture");
  if (!path) return;
  try {
    const bytes = rawFrameBytes(data);
    const now = Date.now();
    const previousAt = previousFrameAt.get(context.connectionId);
    previousFrameAt.set(context.connectionId, now);
    recordSerial += 1;
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        sequence: recordSerial,
        capturedAt: new Date(now).toISOString(),
        elapsedMs: now - startedAt,
        sincePreviousFrameMs: previousAt === undefined ? 0 : Math.max(0, now - previousAt),
        ...context,
        byteLength: bytes.length,
      }),
      "utf8",
    );
    const headerLength = Buffer.allocUnsafe(4);
    headerLength.writeUInt32BE(header.length);
    const payloadLength = Buffer.allocUnsafe(8);
    payloadLength.writeBigUInt64BE(BigInt(bytes.length));

    mkdirSync(dirname(path), { recursive: true });
    const isNew = !existsSync(path) || statSync(path).size === 0;
    const fd = openSync(path, "a", 0o600);
    try {
      if (isNew) writeSync(fd, MAGIC);
      writeSync(fd, headerLength);
      writeSync(fd, header);
      writeSync(fd, payloadLength);
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

export function recordCodexRawLifecycle(
  event: CodexRawLifecycleEvent,
  context: CodexRawLifecycleContext,
): void {
  const capturePath = devtoolPath("codexRawStreamCapture");
  if (!capturePath) return;
  try {
    const now = Date.now();
    const previousAt = previousLifecycleAt.get(context.connectionId);
    previousLifecycleAt.set(context.connectionId, now);
    recordSerial += 1;
    const lifecyclePath = `${capturePath}.lifecycle.jsonl`;
    const record = {
      version: 1,
      sequence: recordSerial,
      capturedAt: new Date(now).toISOString(),
      elapsedMs: now - startedAt,
      sincePreviousLifecycleMs: previousAt === undefined ? 0 : Math.max(0, now - previousAt),
      event,
      ...context,
    };
    mkdirSync(dirname(lifecyclePath), { recursive: true });
    const fd = openSync(lifecyclePath, "a", 0o600);
    try {
      writeSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {}
}

export function recordCodexRawReplayDiagnostic(value: Record<string, unknown>): void {
  const path = devtoolPath("codexRawStreamReplayDiagnostics");
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(
        fd,
        Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, "utf8"),
      );
    } finally {
      closeSync(fd);
    }
  } catch {}
}

function rawFrameBytes(data: string | Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}
