import { beforeEach, describe, expect, it } from "bun:test";
import { dirname, resolve } from "node:path";
import { createBuildIncomingMessage } from "../inbound.ts";

interface MockEntry {
  path: string;
  content: string;
  isDirectory: boolean;
}

const mockFs = new Map<string, MockEntry>();

function normalize(p: string): string {
  return resolve(p);
}

function mkdirMock(p: string, options?: { recursive?: boolean }) {
  const norm = normalize(p);
  if (options?.recursive) {
    let curr = norm;
    const toCreate: string[] = [];
    while (curr && curr !== "/" && curr !== "." && curr !== dirname(curr)) {
      if (!mockFs.has(curr)) {
        toCreate.unshift(curr);
      }
      curr = dirname(curr);
    }
    for (const dir of toCreate) {
      mockFs.set(dir, {
        path: dir,
        content: "",
        isDirectory: true,
      });
    }
  } else {
    const parent = dirname(norm);
    if (parent !== "/" && parent !== "." && !mockFs.has(parent)) {
      throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
    }
    mockFs.set(norm, {
      path: norm,
      content: "",
      isDirectory: true,
    });
  }
}

function writeFileMock(p: string, content: string | Uint8Array) {
  const norm = normalize(p);
  const parent = dirname(norm);
  if (parent !== "/" && parent !== "." && !mockFs.has(parent)) {
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }
  const contentStr = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  mockFs.set(norm, {
    path: norm,
    content: contentStr,
    isDirectory: false,
  });
}

const base = "/tmp/otherside-remote-inbound-test-virtual-dir";

const buildIncomingMessage = createBuildIncomingMessage({
  mkdirSecure: (path, _mode) => {
    mkdirMock(path, { recursive: true });
  },
  writeFileSecure: (path, content, _mode) => {
    writeFileMock(path, content);
  },
  remoteHome: () => base,
});

beforeEach(() => {
  mockFs.clear();
});

describe("buildIncomingMessage", () => {
  it("represents remote image attachments as image refs and image blocks", () => {
    const incoming = buildIncomingMessage("sess", {
      text: "consegue ver?",
      attachments: [
        {
          name: "shot.png",
          mimeType: "image/png",
          base64: "aW1hZ2U=",
        },
      ],
    });

    expect(incoming?.text).toBe("consegue ver?\n[Image #1]");
    expect(incoming?.blocks).toEqual([
      { type: "text", text: "consegue ver?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
    ]);
  });

  it("accepts inlineImages from synced session records", () => {
    const incoming = buildIncomingMessage("sess", {
      text: "describe",
      inlineImages: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "anBn" },
        },
      ],
    });

    expect(incoming?.text).toBe("describe\n[Image #1]");
    expect(incoming?.attachments).toEqual([
      {
        name: "inline-image-1.jpg",
        mimeType: "image/jpeg",
        base64: "anBn",
      },
    ]);
    expect(incoming?.blocks.at(1)).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "anBn" },
    });
  });

  it("keeps non-image attachments as file references", () => {
    const incoming = buildIncomingMessage("sess", {
      text: "read this",
      attachments: [
        {
          name: "note.txt",
          mimeType: "text/plain",
          base64: "aGVsbG8=",
        },
      ],
    });

    expect(incoming?.text).toContain("read this\n@");
    expect(incoming?.text).toContain("note.txt");
    expect(incoming?.blocks.at(1)).toMatchObject({ type: "text" });
  });
});
