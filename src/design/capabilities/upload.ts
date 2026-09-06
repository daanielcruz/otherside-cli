import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fail, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import { isActiveDesignScope } from "@/design/scope.ts";
import { designStorageDir, isValidDesignId, loadDesignSnapshot } from "@/design/storage.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";
import { writeDebugError } from "@/devtools/output.ts";

export const DESIGN_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_CHUNK_MAX_CHARS = 480 * 1024;
const UPLOAD_CHUNK_MAX_COUNT = 64;
const UPLOAD_STATE_MAX_COUNT = 32;
const COMPLETED_UPLOAD_MAX_COUNT = 64;
const UPLOAD_STATE_TTL_MS = 5 * 60 * 1000;
const MAX_BASE64_PAYLOAD_CHARS = Math.ceil(DESIGN_UPLOAD_MAX_BYTES / 3) * 4;
const MAX_CHUNKED_DATA_URL_CHARS = MAX_BASE64_PAYLOAD_CHARS + 256;

interface DirectUploadInput {
  mode: "direct";
  designId: string;
  name: string;
  bytes: Buffer;
}

export interface ChunkUploadInput {
  mode: "chunk";
  designId: string;
  name: string;
  uploadId: string;
  index: number;
  total: number;
  chunk: string;
}

type DesignUploadInput = DirectUploadInput | ChunkUploadInput;

interface PendingUpload {
  designId: string;
  name: string;
  total: number;
  chunks: string[];
  encodedLength: number;
  updatedAt: number;
}

interface CompletedUpload {
  designId: string;
  name: string;
  total: number;
  finalChunk: string;
  path: string;
  updatedAt: number;
}

type CollectedUpload =
  | { complete: false; received: number }
  | { complete: true; dataUrl: string }
  | { complete: true; path: string };

const pendingUploads = new Map<string, PendingUpload>();
const completedUploads = new Map<string, CompletedUpload>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDesignUploadName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value === "." || value === ".." || /[\\/\0\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function decodeDesignUploadDataUrl(dataUrl: unknown): Buffer | string {
  if (typeof dataUrl !== "string") return "dataUrl must be a string";
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) return "dataUrl must contain base64 data";
  const payload = match[1] ?? "";
  if (payload.length % 4 === 1) return "dataUrl contains invalid base64";
  if (payload.length > Math.ceil(DESIGN_UPLOAD_MAX_BYTES / 3) * 4 + 4) {
    return `upload exceeds ${DESIGN_UPLOAD_MAX_BYTES} bytes`;
  }
  const bytes = Buffer.from(payload, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== payload.replace(/=+$/, "")) return "dataUrl contains invalid base64";
  if (bytes.length > DESIGN_UPLOAD_MAX_BYTES) {
    return `upload exceeds ${DESIGN_UPLOAD_MAX_BYTES} bytes`;
  }
  return bytes;
}

function parseDesignId(params: Record<string, unknown>, fallback: string): string | null {
  const designId =
    typeof params.designId === "string" && params.designId.length > 0 ? params.designId : fallback;
  return isValidDesignId(designId) ? designId : null;
}

function parseUpload(params: unknown, fallbackDesignId: string): DesignUploadInput | string {
  if (!isRecord(params)) return "params must be an object";
  const designId = parseDesignId(params, fallbackDesignId);
  if (!designId) return "designId contains unsafe characters";
  const name = validateDesignUploadName(params.name);
  if (!name) return "name must be a safe filename";
  if (params.dataUrl !== undefined) {
    const bytes = decodeDesignUploadDataUrl(params.dataUrl);
    if (typeof bytes === "string") return bytes;
    return { mode: "direct", designId, name, bytes };
  }
  if (typeof params.uploadId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(params.uploadId)) {
    return "uploadId is invalid";
  }
  if (
    typeof params.index !== "number" ||
    !Number.isInteger(params.index) ||
    typeof params.total !== "number" ||
    !Number.isInteger(params.total) ||
    params.total < 1 ||
    params.total > UPLOAD_CHUNK_MAX_COUNT ||
    params.index < 0 ||
    params.index >= params.total
  ) {
    return "chunk index or total is invalid";
  }
  if (typeof params.chunk !== "string" || params.chunk.length > UPLOAD_CHUNK_MAX_CHARS) {
    return "chunk is invalid";
  }
  return {
    mode: "chunk",
    designId,
    name,
    uploadId: params.uploadId,
    index: params.index,
    total: params.total,
    chunk: params.chunk,
  };
}

export function writeDesignUpload(root: string, name: string, bytes: Buffer): string {
  const uploadsDir = join(root, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const extension = extname(name);
  const stem = extension.length > 0 ? name.slice(0, -extension.length) : name;
  let candidate = name;
  let suffix = 2;
  while (true) {
    try {
      writeFileSync(join(uploadsDir, candidate), bytes, { flag: "wx" });
      return `uploads/${candidate}`;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      candidate = `${stem}-${suffix}${extension}`;
      suffix += 1;
    }
  }
}

function clearExpiredUploads(now: number): void {
  for (const [key, upload] of pendingUploads) {
    if (now - upload.updatedAt > UPLOAD_STATE_TTL_MS) pendingUploads.delete(key);
  }
  for (const [key, upload] of completedUploads) {
    if (now - upload.updatedAt > UPLOAD_STATE_TTL_MS) completedUploads.delete(key);
  }
}

function uploadKey(input: ChunkUploadInput, ctx: RpcContext): string {
  return `${ctx.sessionId}:${input.designId}:${input.uploadId}`;
}

function cacheCompletedUpload(
  key: string,
  input: ChunkUploadInput,
  path: string,
  now: number,
): void {
  if (completedUploads.size >= COMPLETED_UPLOAD_MAX_COUNT) {
    const oldest = completedUploads.keys().next().value;
    if (oldest) completedUploads.delete(oldest);
  }
  completedUploads.set(key, {
    designId: input.designId,
    name: input.name,
    total: input.total,
    finalChunk: input.chunk,
    path,
    updatedAt: now,
  });
}

export function collectUploadChunk(
  input: ChunkUploadInput,
  ctx: RpcContext,
): CollectedUpload | string {
  const now = Date.now();
  clearExpiredUploads(now);
  const key = uploadKey(input, ctx);
  const completed = completedUploads.get(key);
  if (completed) {
    if (
      input.index === input.total - 1 &&
      completed.designId === input.designId &&
      completed.name === input.name &&
      completed.total === input.total &&
      completed.finalChunk === input.chunk
    ) {
      completed.updatedAt = now;
      return { complete: true, path: completed.path };
    }
    return "upload is already complete";
  }
  let pending = pendingUploads.get(key);
  if (!pending) {
    if (input.index !== 0) return "upload chunks must arrive in order";
    if (pendingUploads.size >= UPLOAD_STATE_MAX_COUNT) return "too many uploads in progress";
    pending = {
      designId: input.designId,
      name: input.name,
      total: input.total,
      chunks: [],
      encodedLength: 0,
      updatedAt: now,
    };
    pendingUploads.set(key, pending);
  }
  if (
    pending.designId !== input.designId ||
    pending.name !== input.name ||
    pending.total !== input.total
  ) {
    return "upload metadata changed between chunks";
  }
  const received = pending.chunks.length;
  if (input.index < received) {
    if (pending.chunks[input.index] !== input.chunk) return "upload chunk changed during retry";
    if (received === pending.total && input.index === pending.total - 1) {
      return { complete: true, dataUrl: pending.chunks.join("") };
    }
    return { complete: false, received };
  }
  if (input.index !== received) return "upload chunks must arrive in order";
  if (pending.encodedLength + input.chunk.length > MAX_CHUNKED_DATA_URL_CHARS) {
    pendingUploads.delete(key);
    return `upload exceeds ${DESIGN_UPLOAD_MAX_BYTES} bytes`;
  }
  pending.chunks.push(input.chunk);
  pending.encodedLength += input.chunk.length;
  pending.updatedAt = now;
  if (pending.chunks.length < pending.total) {
    return { complete: false, received: pending.chunks.length };
  }
  return { complete: true, dataUrl: pending.chunks.join("") };
}

function completeUpload(input: ChunkUploadInput, ctx: RpcContext, path: string): void {
  const now = Date.now();
  const key = uploadKey(input, ctx);
  pendingUploads.delete(key);
  cacheCompletedUpload(key, input, path, now);
}

function writeUpload(input: DirectUploadInput, ctx: RpcContext): string {
  return writeDesignUpload(designStorageDir(ctx.cwd, input.designId), input.name, input.bytes);
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parseUpload(params, ctx.activeDesignId ?? "");
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  if (!isActiveDesignScope(ctx, parsed.designId)) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "designId is not open"));
    return;
  }
  const snapshot =
    ctx.snapshots.get(parsed.designId) ?? loadDesignSnapshot(ctx.cwd, parsed.designId);
  if (!snapshot) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "unknown designId"));
    return;
  }
  try {
    if (parsed.mode === "direct") {
      ctx.send(success(id, { uploaded: true, path: writeUpload(parsed, ctx) }));
      return;
    }
    const collected = collectUploadChunk(parsed, ctx);
    if (typeof collected === "string") {
      ctx.send(fail(id, RPC_INVALID_PARAMS, collected));
      return;
    }
    if (!collected.complete) {
      ctx.send(success(id, { uploaded: false, received: collected.received }));
      return;
    }
    if ("path" in collected) {
      ctx.send(success(id, { uploaded: true, path: collected.path }));
      return;
    }
    const bytes = decodeDesignUploadDataUrl(collected.dataUrl);
    if (typeof bytes === "string") {
      pendingUploads.delete(uploadKey(parsed, ctx));
      ctx.send(fail(id, RPC_INVALID_PARAMS, bytes));
      return;
    }
    const direct: DirectUploadInput = {
      mode: "direct",
      designId: parsed.designId,
      name: parsed.name,
      bytes,
    };
    const path = writeUpload(direct, ctx);
    completeUpload(parsed, ctx, path);
    ctx.send(success(id, { uploaded: true, path }));
  } catch (error) {
    writeDebugError("design upload failed", error);
    ctx.send(fail(id, RPC_INTERNAL_ERROR, "upload failed"));
  }
}

export const DesignUploadCapability: DesignCapability = {
  name: "design.upload",
  rpcMethod: { method: "design.upload", handler: handle },
};
