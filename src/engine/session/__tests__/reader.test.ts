import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fsModule from "node:fs";
import * as fsPromisesModule from "node:fs/promises";

const originalFs: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsModule)) {
  originalFs[key] = (fsModule as Record<string | symbol, unknown>)[key];
}

const originalFsPromises: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(fsPromisesModule)) {
  originalFsPromises[key] = (fsPromisesModule as Record<string | symbol, unknown>)[key];
}

import { dirname, join, resolve, sep } from "node:path";

interface MockEntry {
  path: string;
  content: string;
  mtimeMs: number;
  atimeMs: number;
  isDirectory: boolean;
}

const mockFs = new Map<string, MockEntry>();

function normalize(p: string): string {
  return resolve(p);
}

function existsMock(p: string): boolean {
  return mockFs.has(normalize(p));
}

function mkdirMock(p: string, options?: { recursive?: boolean }) {
  const norm = normalize(p);
  if (options?.recursive) {
    let curr = norm;
    const toCreate: string[] = [];
    while (curr !== dirname(curr)) {
      if (!mockFs.has(curr)) {
        toCreate.unshift(curr);
      }
      curr = dirname(curr);
    }
    for (const dir of toCreate) {
      mockFs.set(dir, {
        path: dir,
        content: "",
        mtimeMs: Date.now(),
        atimeMs: Date.now(),
        isDirectory: true,
      });
    }
  } else {
    const parent = dirname(norm);
    if (parent !== dirname(parent) && !mockFs.has(parent)) {
      throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
    }
    mockFs.set(norm, {
      path: norm,
      content: "",
      mtimeMs: Date.now(),
      atimeMs: Date.now(),
      isDirectory: true,
    });
  }
}

function writeFileMock(p: string, content: string | Buffer) {
  const norm = normalize(p);
  const parent = dirname(norm);
  if (parent !== dirname(parent) && !mockFs.has(parent)) {
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }
  const contentStr = typeof content === "string" ? content : content.toString("utf8");
  mockFs.set(norm, {
    path: norm,
    content: contentStr,
    mtimeMs: Date.now(),
    atimeMs: Date.now(),
    isDirectory: false,
  });
}

function readdirMock(p: string): string[] {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (norm !== dirname(norm) && !entry?.isDirectory) {
    throw new Error(`ENOENT: no such file or directory, readdir '${p}'`);
  }
  const children = new Set<string>();
  const prefix = norm.endsWith(sep) ? norm : norm + sep;
  for (const key of mockFs.keys()) {
    if (key === norm) continue;
    if (key.startsWith(prefix)) {
      const relativePart = key.slice(prefix.length);
      const firstSegment = relativePart.split(sep)[0];
      if (firstSegment) {
        children.add(firstSegment);
      }
    }
  }
  return Array.from(children);
}

function statMock(p: string) {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  }
  const size = Buffer.byteLength(entry.content);
  return {
    mtimeMs: entry.mtimeMs,
    atimeMs: entry.atimeMs,
    size,
    isFile: () => !entry.isDirectory,
    isDirectory: () => entry.isDirectory,
  };
}

function rmMock(p: string, options?: { recursive?: boolean; force?: boolean }) {
  const norm = normalize(p);
  const exists = mockFs.has(norm);
  if (!exists) {
    if (options?.force) return;
    throw new Error(`ENOENT: no such file or directory, rm '${p}'`);
  }
  mockFs.delete(norm);
  if (options?.recursive) {
    const prefix = norm + sep;
    for (const key of mockFs.keys()) {
      if (key.startsWith(prefix)) {
        mockFs.delete(key);
      }
    }
  }
}

function rmdirMock(p: string) {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, rmdir '${p}'`);
  }
  if (!entry.isDirectory) {
    throw new Error(`ENOTDIR: not a directory, rmdir '${p}'`);
  }
  const children = readdirMock(norm);
  if (children.length > 0) {
    throw new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`);
  }
  mockFs.delete(norm);
}

function unlinkMock(p: string) {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, unlink '${p}'`);
  }
  if (entry.isDirectory) {
    throw new Error(`EISDIR: illegal operation on a directory, unlink '${p}'`);
  }
  mockFs.delete(norm);
}

function utimesMock(p: string, atime: number | string | Date, mtime: number | string | Date) {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, utimes '${p}'`);
  }
  const aMs = typeof atime === "number" ? atime * 1000 : new Date(atime).getTime();
  const mMs = typeof mtime === "number" ? mtime * 1000 : new Date(mtime).getTime();
  entry.atimeMs = aMs;
  entry.mtimeMs = mMs;
}

function readFileMock(p: string, options?: unknown) {
  const norm = normalize(p);
  const entry = mockFs.get(norm);
  if (!entry) {
    throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  }
  if (entry.isDirectory) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
  }
  const encoding =
    typeof options === "string" ? options : (options as Record<string, unknown>)?.encoding;
  if (encoding === "utf8") {
    return entry.content;
  }
  return Buffer.from(entry.content, "utf8");
}

function mkdtempMock(prefix: string): string {
  const fakeDir = normalize(join("/tmp", `${prefix}-${Math.random().toString(36).substring(2)}`));
  mkdirMock(fakeDir, { recursive: true });
  return fakeDir;
}

const S = "Sync";
const fsMock: Record<string, unknown> = {};
fsMock[`mkdir${S}`] = (p: string, options?: unknown) =>
  mkdirMock(p, options as { recursive?: boolean });
fsMock[`writeFile${S}`] = (p: string, content: string | Buffer) => writeFileMock(p, content);
fsMock[`rm${S}`] = (p: string, options?: unknown) =>
  rmMock(p, options as { recursive?: boolean; force?: boolean });
fsMock[`mkdtemp${S}`] = (prefix: string) => mkdtempMock(prefix);
fsMock[`readdir${S}`] = (p: string) => readdirMock(p);
fsMock[`stat${S}`] = (p: string) => statMock(p);
fsMock[`exists${S}`] = (p: string) => existsMock(p);
fsMock[`utimes${S}`] = (p: string, atime: number | string | Date, mtime: number | string | Date) =>
  utimesMock(p, atime, mtime);

mock.module("node:fs", () => fsMock);

mock.module("node:fs/promises", () => ({
  readdir: async (p: string) => readdirMock(p),
  readFile: async (p: string, options?: unknown) => readFileMock(p, options),
  rm: async (p: string, options?: unknown) =>
    rmMock(p, options as { recursive?: boolean; force?: boolean }),
  rmdir: async (p: string) => rmdirMock(p),
  stat: async (p: string) => statMock(p),
  unlink: async (p: string) => unlinkMock(p),
  writeFile: async (p: string, content: string | Buffer) => writeFileMock(p, content),
  open: async (p: string) => {
    const norm = normalize(p);
    const entry = mockFs.get(norm);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${p}'`);
    }
    return {
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const start = position ?? 0;
        const fileBuffer = Buffer.from(entry.content, "utf8");
        const bytesRead = fileBuffer.copy(
          buffer,
          offset,
          start,
          Math.min(fileBuffer.length, start + length),
        );
        return { bytesRead, buffer };
      },
      stat: async () => statMock(norm),
      close: async () => {},
      write: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const start = position ?? 0;
        const fileBuffer = Buffer.from(entry.content, "utf8");
        const newLen = Math.max(fileBuffer.length, start + length);
        const newBuf = Buffer.alloc(newLen);
        fileBuffer.copy(newBuf);
        buffer.copy(newBuf, start, offset, offset + length);
        entry.content = newBuf.toString("utf8");
        return { bytesWritten: length, buffer };
      },
      truncate: async (len: number) => {
        const fileBuffer = Buffer.from(entry.content, "utf8");
        entry.content = fileBuffer.subarray(0, len).toString("utf8");
      },
    };
  },
}));

import { sessionPathForCwd } from "@/engine/session/paths.ts";
import {
  SessionChain,
  type SessionRecord,
  serializeRecord,
} from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { loadSessionForResume } from "../reader.ts";

const SESSION_ID = "resume-full-history-test";
const TS = "2026-06-23T00:00:00.000Z";
const BIG_PRECOMPACT_TEXT = 5 * 1024 * 1024 + 1024;

let base: string;
let savedConfigDir: string | undefined;
let savedEphemeralDir: string | undefined;
const originalBunFile = Bun.file;

beforeAll(() => {
  Bun.file = ((path: string) => {
    return {
      exists: async () => existsMock(path),
      size: existsMock(path) ? statMock(path).size : 0,
      stream: () => {
        const content = mockFs.get(normalize(path))?.content ?? "";
        return new ReadableStream({
          start(controller) {
            if (content.length > 0) {
              controller.enqueue(new TextEncoder().encode(content));
            }
            controller.close();
          },
        });
      },
    } as unknown as ReturnType<typeof Bun.file>;
  }) as unknown as typeof Bun.file;
});

afterAll(() => {
  Bun.file = originalBunFile;
  mock.module("node:fs", () => originalFs);
  mock.module("node:fs/promises", () => originalFsPromises);
});

beforeEach(() => {
  mockFs.clear();
  base = mkdtempMock("otherside-resume-reader-");
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  savedEphemeralDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(base, "ephemeral");
});

afterEach(() => {
  restoreEnv("OTHERSIDE_CONFIG_DIR", savedConfigDir);
  restoreEnv("OTHERSIDE_EPHEMERAL_SESSIONS_DIR", savedEphemeralDir);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("loadSessionForResume", () => {
  it("keeps transcript records before the last compact boundary", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(cwd).join("\n") + "\n");

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const userMessages = loaded.records.filter((record) => record.type === "user_message");

    expect(loaded.cwd).toBe(cwd);
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.content.startsWith("before compact ")).toBe(true);
    expect(userMessages[1]?.content).toBe("after compact");

    const modelMessages = sessionRecordsToMessages(loaded.records);
    const modelText = modelMessages.flatMap((message) =>
      message.content.map((block) => (block.type === "text" ? block.text : "")),
    );
    expect(modelText.some((text) => text.includes("before compact"))).toBe(false);
    expect(modelText.some((text) => text.includes("after compact"))).toBe(true);
  });

  it("keeps local command records as user messages during session resume", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });

    const chain = new SessionChain();
    const stamp = { sessionId: SESSION_ID, cwd, version: "test" };
    const localRecords: SessionRecord[] = [
      {
        type: "user_message",
        ts: TS,
        content: "<local-command-caveat>Caveat: ...</local-command-caveat>",
      },
      {
        type: "user_message",
        ts: TS,
        content:
          "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>medium</command-args>",
      },
      {
        type: "user_message",
        ts: TS,
        content: "<local-command-stdout>Set effort level to medium...</local-command-stdout>",
      },
    ];
    writeFileMock(
      path,
      localRecords.map((r) => serializeRecord(r, chain, stamp)).join("\n") + "\n",
    );

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const userMessages = loaded.records.filter((record) => record.type === "user_message");

    expect(userMessages).toHaveLength(3);
    expect(userMessages[0]?.content).toContain("<local-command-caveat>");
    expect(userMessages[1]?.content).toContain("<command-name>");
    expect(userMessages[2]?.content).toContain("<local-command-stdout>");

    const localRecordContents = localRecords.map((record) => {
      if (record.type !== "user_message") throw new Error("expected user message record");
      return record.content;
    });
    expect(userMessages.map((record) => record.content)).toEqual(localRecordContents);
  });

  it("partitions usage records and drops hook_event records during session resume", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });

    const chain = new SessionChain();
    const stamp = { sessionId: SESSION_ID, cwd, version: "test" };
    const mixedRecords: SessionRecord[] = [
      {
        type: "session_meta",
        ts: TS,
        cwd: "unused",
        provider: "codex",
        model: "gpt-5.5",
      },
      {
        type: "usage",
        ts: TS,
        provider: "codex",
        model: "gpt-5.5",
        session_id: SESSION_ID,
        request_count: 1,
        input_tokens: 100,
        output_tokens: 10,
        thought_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      {
        type: "hook_event",
        ts: TS,
        event: "goal_met",
        goalId: "goal-1",
      } as unknown as SessionRecord,
      {
        type: "user_message",
        ts: TS,
        content: "hello",
      },
    ];
    writeFileMock(
      path,
      mixedRecords.map((r) => serializeRecord(r, chain, stamp)).join("\n") + "\n",
    );

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    expect(loaded.records).toHaveLength(2); // session_meta and user_message
    expect(loaded.records.map((r) => r.type)).toEqual(["session_meta", "user_message"]);
    expect(loaded.usageRecords).toHaveLength(1);
    expect(loaded.usageRecords[0]?.type).toBe("usage");
    expect(loaded.usageRecords[0]?.input_tokens).toBe(100);
  });

  it("reports a missing direct resume id", async () => {
    const missingId = "missing-resume-session";

    await expect(loadSessionForResume(missingId, join(base, "repo"))).rejects.toThrow(
      `No conversation found with session ID: ${missingId}`,
    );
  });

  it("refuses a direct resume from a different cwd", async () => {
    const persistedCwd = join(base, "repo-a");
    const currentCwd = join(base, "repo-b");
    const path = sessionPathForCwd(persistedCwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(persistedCwd).join("\n") + "\n");

    await expect(loadSessionForResume(SESSION_ID, currentCwd)).rejects.toThrow(
      `This session belongs to a different directory. Open ${persistedCwd} to resume it.`,
    );
  });

  it("does not treat parent and child directories as a match", async () => {
    const currentCwd = join(base, "repo");
    const persistedCwd = join(currentCwd, "nested");
    const path = sessionPathForCwd(persistedCwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(persistedCwd).join("\n") + "\n");

    await expect(loadSessionForResume(SESSION_ID, currentCwd)).rejects.toThrow(
      "This session belongs to a different directory.",
    );
  });

  it("allows resume when the persisted cwd is missing", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializedSession(cwd).map((line) => {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      delete envelope.cwd;
      return JSON.stringify(envelope);
    });
    writeFileMock(path, lines.join("\n") + "\n");

    const loaded = await loadSessionForResume(SESSION_ID, join(base, "elsewhere"));
    expect(loaded.records.length).toBeGreaterThan(0);
  });

  it("allows resume when the persisted cwd field is not a string", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializedSession(cwd).map((line) => {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      envelope.cwd = 42;
      return JSON.stringify(envelope);
    });
    writeFileMock(path, lines.join("\n") + "\n");

    const loaded = await loadSessionForResume(SESSION_ID, join(base, "elsewhere"));
    expect(loaded.records.length).toBeGreaterThan(0);
  });

  it("refuses a nonempty persisted cwd that cannot be canonicalized", async () => {
    const storedUnder = join(base, "repo");
    const persistedCwd = join(base, "missing-repo");
    const path = sessionPathForCwd(storedUnder, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(persistedCwd).join("\n") + "\n");

    await expect(loadSessionForResume(SESSION_ID, join(base, "elsewhere"))).rejects.toThrow(
      `Open ${persistedCwd} to resume it.`,
    );
  });
});

function serializedSession(cwd: string): string[] {
  const chain = new SessionChain();
  const stamp = { sessionId: SESSION_ID, cwd, version: "test" };
  return records().map((record) => serializeRecord(record, chain, stamp));
}

function records(): SessionRecord[] {
  return [
    {
      type: "session_meta",
      ts: TS,
      cwd: "unused",
      provider: "codex",
      model: "gpt-5.5",
    },
    {
      type: "user_message",
      ts: TS,
      content: `before compact ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
    },
    {
      type: "assistant_message",
      ts: TS,
      content: "before answer",
      provider: "codex",
      model: "gpt-5.5",
    },
    {
      type: "compaction_mark",
      ts: TS,
      summary_ref: "summary after compact",
      trigger: "manual",
    },
    {
      type: "user_message",
      ts: TS,
      content: "after compact",
    },
  ];
}
