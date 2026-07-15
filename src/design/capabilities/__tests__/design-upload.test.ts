import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDesignImagePath } from "@/design/capabilities/design-agent-tools.ts";
import {
  collectUploadChunk,
  DESIGN_UPLOAD_MAX_BYTES,
  DesignUploadCapability,
  decodeDesignUploadDataUrl,
  validateDesignUploadName,
  writeDesignUpload,
} from "@/design/capabilities/design-upload.ts";
import { registerDesignFork, unregisterDesignFork } from "@/design/fork-context.ts";
import { designStorageDir } from "@/design/storage.ts";
import type { RpcContext } from "@/design/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "otherside-design-upload-"));
  roots.push(root);
  return root;
}

describe("design.upload storage", () => {
  it("decodes base64 bytes and rejects malformed data", () => {
    const decoded = decodeDesignUploadDataUrl("data:text/plain;base64,aGVsbG8=");
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect((decoded as Buffer).toString("utf8")).toBe("hello");
    expect(decodeDesignUploadDataUrl("plain text")).toBe("dataUrl must contain base64 data");
    expect(decodeDesignUploadDataUrl("data:text/plain;base64,%%%%")).toBe(
      "dataUrl must contain base64 data",
    );
  });

  it("rejects unsafe names and decoded payloads above 20 MiB", () => {
    for (const name of ["../x.png", "dir/x.png", "dir\\x.png", ".", "..", "bad\0.png"]) {
      expect(validateDesignUploadName(name)).toBeNull();
    }
    expect(validateDesignUploadName("reference image.png")).toBe("reference image.png");
    const oversized = Buffer.alloc(DESIGN_UPLOAD_MAX_BYTES + 1).toString("base64");
    expect(decodeDesignUploadDataUrl(`data:application/octet-stream;base64,${oversized}`)).toBe(
      `upload exceeds ${DESIGN_UPLOAD_MAX_BYTES} bytes`,
    );
  });

  it("writes under uploads and suffixes collisions without overwriting", () => {
    const root = tempRoot();
    const first = writeDesignUpload(root, "reference.png", Buffer.from("first"));
    const second = writeDesignUpload(root, "reference.png", Buffer.from("second"));
    expect(first).toBe("uploads/reference.png");
    expect(second).toBe("uploads/reference-2.png");
    expect(readFileSync(join(root, first), "utf8")).toBe("first");
    expect(readFileSync(join(root, second), "utf8")).toBe("second");
  });

  it("reassembles ordered chunks and acknowledges intermediate data", () => {
    const ctx = { sessionId: "session-1" } as RpcContext;
    const first = collectUploadChunk(
      {
        mode: "chunk",
        designId: "design-1",
        name: "reference.txt",
        uploadId: "upload-12345678",
        index: 0,
        total: 2,
        chunk: "data:text/plain;base64,aGVs",
      },
      ctx,
    );
    expect(first).toEqual({ complete: false, received: 1 });
    const second = collectUploadChunk(
      {
        mode: "chunk",
        designId: "design-1",
        name: "reference.txt",
        uploadId: "upload-12345678",
        index: 1,
        total: 2,
        chunk: "bG8=",
      },
      ctx,
    );
    expect(second).toEqual({
      complete: true,
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    });
  });

  it("allows a one-chunk upload and reuses its completed path after a lost ACK", () => {
    const root = tempRoot();
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = root;
    const responses: unknown[] = [];
    const ctx = {
      cwd: root,
      designId: "design-1",
      activeDesignId: "design-1",
      sessionId: "single-chunk-session",
      snapshots: new Map([["design-1", {}]]),
      send(response: unknown) {
        responses.push(response);
      },
    } as RpcContext;
    const params = {
      designId: "design-1",
      name: "reference.txt",
      uploadId: "upload-single-1234",
      index: 0,
      total: 1,
      chunk: "data:text/plain;base64,aGVsbG8=",
    };
    try {
      DesignUploadCapability.rpcMethod?.handler(params, ctx, 1);
      DesignUploadCapability.rpcMethod?.handler(params, ctx, 2);
      expect(responses).toEqual([
        { jsonrpc: "2.0", id: 1, result: { uploaded: true, path: "uploads/reference.txt" } },
        { jsonrpc: "2.0", id: 2, result: { uploaded: true, path: "uploads/reference.txt" } },
      ]);
      expect(readdirSync(join(designStorageDir(root, "design-1"), "uploads"))).toEqual([
        "reference.txt",
      ]);

      DesignUploadCapability.rpcMethod?.handler(
        { ...params, chunk: "data:text/plain;base64,aGk=" },
        ctx,
        3,
      );
      expect(responses[2]).toEqual({
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32602, message: "upload is already complete" },
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it("rejects cumulative oversized chunks before assembling them", () => {
    const ctx = { sessionId: "oversize-session" } as RpcContext;
    const chunk = "a".repeat(480 * 1024);
    for (let index = 0; index < 56; index += 1) {
      expect(
        collectUploadChunk(
          {
            mode: "chunk",
            designId: "design-oversize",
            name: "reference.txt",
            uploadId: "upload-oversize-1234",
            index,
            total: 64,
            chunk,
          },
          ctx,
        ),
      ).toEqual({ complete: false, received: index + 1 });
    }
    expect(
      collectUploadChunk(
        {
          mode: "chunk",
          designId: "design-oversize",
          name: "reference.txt",
          uploadId: "upload-oversize-1234",
          index: 56,
          total: 64,
          chunk,
        },
        ctx,
      ),
    ).toBe(`upload exceeds ${DESIGN_UPLOAD_MAX_BYTES} bytes`);
    expect(
      collectUploadChunk(
        {
          mode: "chunk",
          designId: "design-oversize",
          name: "reference.txt",
          uploadId: "upload-oversize-1234",
          index: 0,
          total: 64,
          chunk: "data:text/plain;base64,",
        },
        ctx,
      ),
    ).toEqual({ complete: false, received: 1 });
  });

  it("resolves uploaded images inside the active design and rejects traversal", () => {
    const cwd = tempRoot();
    const owner = "upload-path-test";
    registerDesignFork(owner, {
      designId: "design-1",
      cwd,
      snapshots: new Map(),
      emit() {},
    });
    try {
      const ctx = { cwd: "/unrelated", agentOwnerId: owner } as RequestContext;
      expect(resolveDesignImagePath("uploads/reference.png", ctx)).toBe(
        join(designStorageDir(cwd, "design-1"), "uploads", "reference.png"),
      );
      expect(resolveDesignImagePath("uploads/../secret.png", ctx)).toBeNull();
      expect(resolveDesignImagePath("uploads/nested/reference.png", ctx)).toBeNull();
    } finally {
      unregisterDesignFork(owner);
    }
  });
});
