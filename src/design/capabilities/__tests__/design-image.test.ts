import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_IMAGE_CHUNK_BYTES,
  DesignImageCapability,
  DesignImageChunkCapability,
} from "@/design/capabilities/design-image.ts";
import type { RpcContext } from "@/design/types.ts";

const roots: string[] = [];
const originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "otherside-design-image-"));
  roots.push(root);
  process.env.OTHERSIDE_CONFIG_DIR = root;
  return root;
}

function invoke(name: string): unknown {
  const responses: unknown[] = [];
  const ctx = {
    send(response: unknown) {
      responses.push(response);
    },
  } as RpcContext;
  DesignImageCapability.rpcMethod?.handler({ name }, ctx, 1);
  return responses[0];
}

function invokeChunk(name: string, offset: number): unknown {
  const responses: unknown[] = [];
  const ctx = {
    send(response: unknown) {
      responses.push(response);
    },
  } as RpcContext;
  DesignImageChunkCapability.rpcMethod?.handler({ name, offset }, ctx, 1);
  return responses[0];
}

describe("design.image", () => {
  it("does not expose the cache path when an image is unavailable", () => {
    const root = tempRoot();
    const response = invoke("missing.png");

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "image unavailable" },
    });
    expect(JSON.stringify(response)).not.toContain(root);
  });

  it("returns a cached image as a data URL", () => {
    const root = tempRoot();
    const cache = join(root, "image-cache");
    mkdirSync(cache);
    writeFileSync(join(cache, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(invoke("pixel.png")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        name: "pixel.png",
        dataUrl: "data:image/png;base64,iVBORw==",
      },
    });
  });
});

describe("design.image.chunk", () => {
  it("returns a cached image in relay-sized chunks", () => {
    const root = tempRoot();
    const cache = join(root, "image-cache");
    mkdirSync(cache);
    const bytes = Buffer.alloc(DESIGN_IMAGE_CHUNK_BYTES + 2, 0xab);
    writeFileSync(join(cache, "large.png"), bytes);

    expect(invokeChunk("large.png", 0)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        name: "large.png",
        mediaType: "image/png",
        chunk: bytes.subarray(0, DESIGN_IMAGE_CHUNK_BYTES).toString("base64"),
        offset: 0,
        nextOffset: DESIGN_IMAGE_CHUNK_BYTES,
        totalBytes: bytes.length,
        done: false,
      },
    });
    expect(invokeChunk("large.png", DESIGN_IMAGE_CHUNK_BYTES)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        name: "large.png",
        mediaType: "image/png",
        chunk: bytes.subarray(DESIGN_IMAGE_CHUNK_BYTES).toString("base64"),
        offset: DESIGN_IMAGE_CHUNK_BYTES,
        nextOffset: bytes.length,
        totalBytes: bytes.length,
        done: true,
      },
    });
  });

  it("rejects offsets beyond the image", () => {
    const root = tempRoot();
    const cache = join(root, "image-cache");
    mkdirSync(cache);
    writeFileSync(join(cache, "pixel.png"), Buffer.from([0x89]));

    expect(invokeChunk("pixel.png", 2)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "offset exceeds image size" },
    });
  });
});
