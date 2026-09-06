import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fail, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, success } from "@/design/bridge/envelope.ts";
import type { DesignCapability, JsonRpcId, RpcContext } from "@/design/types.ts";
import { imageCacheRoot } from "@/kernel/std/paths.ts";

interface ImageInput {
  name: string;
}

interface ImageChunkInput extends ImageInput {
  offset: number;
}

// 360 KiB becomes 480 KiB base64, leaving room for relay envelopes under 1 MiB.
export const DESIGN_IMAGE_CHUNK_BYTES = 360 * 1024;

const MEDIA_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The web sends whatever the design used as the <img> src: an "os-asset:<file>"
// ref, or a legacy "~/.otherside/image-cache/<file>" / bare path. Reduce any of
// them to a filename and reject anything that isn't a cached image basename, so
// the RPC can only ever read out of the image cache.
function parse(params: unknown): ImageInput | string {
  if (!isRecord(params)) return "params must be an object";
  const raw = params.name;
  if (typeof raw !== "string" || raw.length === 0) {
    return "name must be a non-empty string";
  }
  const stripped = raw.startsWith("os-asset:") ? raw.slice("os-asset:".length) : raw;
  const name = basename(stripped);
  if (name.length === 0 || name === "." || name === "..") {
    return "name does not resolve to a cached image";
  }
  return { name };
}

function parseChunk(params: unknown): ImageChunkInput | string {
  const parsed = parse(params);
  if (typeof parsed === "string") return parsed;
  if (!isRecord(params) || !Number.isInteger(params.offset) || Number(params.offset) < 0) {
    return "offset must be a non-negative integer";
  }
  return { ...parsed, offset: Number(params.offset) };
}

function imagePayload(
  name: string,
): { bytes: Buffer; mediaType: string } | "unsupported image type" | "image unavailable" {
  const mediaType = MEDIA_BY_EXT[extname(name).toLowerCase()];
  if (!mediaType) return "unsupported image type";
  try {
    return { bytes: readFileSync(join(imageCacheRoot(), name)), mediaType };
  } catch {
    return "image unavailable";
  }
}

function handle(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parse(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  const payload = imagePayload(parsed.name);
  if (typeof payload === "string") {
    ctx.send(
      fail(
        id,
        payload === "unsupported image type" ? RPC_INVALID_PARAMS : RPC_INTERNAL_ERROR,
        payload,
      ),
    );
    return;
  }
  const dataUrl = `data:${payload.mediaType};base64,${payload.bytes.toString("base64")}`;
  ctx.send(success(id, { name: parsed.name, dataUrl }));
}

function handleChunk(params: unknown, ctx: RpcContext, id: JsonRpcId): void {
  const parsed = parseChunk(params);
  if (typeof parsed === "string") {
    ctx.send(fail(id, RPC_INVALID_PARAMS, parsed));
    return;
  }
  const payload = imagePayload(parsed.name);
  if (typeof payload === "string") {
    ctx.send(
      fail(
        id,
        payload === "unsupported image type" ? RPC_INVALID_PARAMS : RPC_INTERNAL_ERROR,
        payload,
      ),
    );
    return;
  }
  if (parsed.offset > payload.bytes.length) {
    ctx.send(fail(id, RPC_INVALID_PARAMS, "offset exceeds image size"));
    return;
  }
  const nextOffset = Math.min(parsed.offset + DESIGN_IMAGE_CHUNK_BYTES, payload.bytes.length);
  ctx.send(
    success(id, {
      name: parsed.name,
      mediaType: payload.mediaType,
      chunk: payload.bytes.subarray(parsed.offset, nextOffset).toString("base64"),
      offset: parsed.offset,
      nextOffset,
      totalBytes: payload.bytes.length,
      done: nextOffset === payload.bytes.length,
    }),
  );
}

export const DesignImageCapability: DesignCapability = {
  name: "design.image",
  rpcMethod: {
    method: "design.image",
    handler: handle,
  },
};

export const DesignImageChunkCapability: DesignCapability = {
  name: "design.image.chunk",
  rpcMethod: {
    method: "design.image.chunk",
    handler: handleChunk,
  },
};
