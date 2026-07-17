import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as childProcessModule from "node:child_process";
import * as fsModule from "node:fs";
import * as fsPromisesModule from "node:fs/promises";

const originalChildProcess: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(childProcessModule)) {
  originalChildProcess[key] = (childProcessModule as Record<string | symbol, unknown>)[key];
}

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
const fsMock: Record<string | symbol, unknown> = { ...originalFs };
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

mock.module("node:child_process", () => ({
  ...originalChildProcess,
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(null, "", ""),
  spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
}));

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
  lineToRecord,
  SessionChain,
  type SessionRecord,
  serializeRecord,
} from "@/engine/session/record/index.ts";
import { resolveSessionBrokerState } from "@/engine/session/state.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import {
  loadSessionForResume,
  readActiveChainLines,
  readMainChainLines,
  recordsFromLines,
} from "../reader.ts";

const SESSION_ID = "resume-full-history-test";
const TS = "2026-06-23T00:00:00.000Z";
const BIG_PRECOMPACT_TEXT = 5 * 1024 * 1024 + 1024;

let base: string;
let savedConfigDir: string | undefined;
let savedEphemeralDir: string | undefined;
let savedDisablePrecompactSkip: string | undefined;
let savedResumeTailEntries: string | undefined;
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
  mock.module("node:child_process", () => originalChildProcess);
  mock.module("node:fs", () => originalFs);
  mock.module("node:fs/promises", () => originalFsPromises);
});

beforeEach(() => {
  mockFs.clear();
  base = mkdtempMock("otherside-resume-reader-");
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  savedEphemeralDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  savedDisablePrecompactSkip = process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP;
  savedResumeTailEntries = process.env.OTHERSIDE_RESUME_TAIL_ENTRIES;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(base, "ephemeral");
  delete process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP;
  delete process.env.OTHERSIDE_RESUME_TAIL_ENTRIES;
});

afterEach(() => {
  restoreEnv("OTHERSIDE_CONFIG_DIR", savedConfigDir);
  restoreEnv("OTHERSIDE_EPHEMERAL_SESSIONS_DIR", savedEphemeralDir);
  restoreEnv("OTHERSIDE_DISABLE_PRECOMPACT_SKIP", savedDisablePrecompactSkip);
  restoreEnv("OTHERSIDE_RESUME_TAIL_ENTRIES", savedResumeTailEntries);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("loadSessionForResume", () => {
  it("keeps full render history for a large transcript while model input stays cut", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(cwd).join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const mainLines = await readMainChainLines(SESSION_ID);
    expect(activeLines).toEqual(mainLines);

    const records = recordsFromLines(activeLines);
    const userMessages = records.filter((record) => record.type === "user_message");
    expect(userMessages.map((record) => record.content)).toEqual([
      expect.stringContaining("before compact"),
      "after compact",
    ]);

    const modelMessages = sessionRecordsToMessages(records);
    const modelText = modelMessages.flatMap((message) =>
      message.content.map((block) => (block.type === "text" ? block.text : "")),
    );
    expect(modelText.some((text) => text.includes("before compact"))).toBe(false);
    expect(modelText.some((text) => text.includes("after compact"))).toBe(true);
  });

  it("keeps and relinks a preserved tail in a large transcript", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, preservedSession(cwd).join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const chain = activeLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) =>
          typeof line.uuid === "string" &&
          "parentUuid" in line &&
          (line.type === "user" ||
            line.type === "assistant" ||
            (line.type === "system" && line.subtype === "compact_boundary")),
      );
    const byUuid = new Map(chain.map((line) => [line.uuid, line]));

    expect(chain.map((line) => line.uuid)).toEqual([
      "discarded-user",
      "keep-user",
      "keep-assistant",
      "boundary",
      "post-user",
    ]);
    expect(byUuid.get("keep-user")?.parentUuid).toBe("boundary");
    expect(byUuid.get("keep-assistant")?.parentUuid).toBe("keep-user");
    expect(byUuid.get("post-user")?.parentUuid).toBe("keep-assistant");
    const assistantMessage = byUuid.get("keep-assistant")?.message as
      | { usage?: Record<string, unknown> }
      | undefined;
    expect(assistantMessage?.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const assistantSidecar = byUuid.get("keep-assistant")?._os as
      | Record<string, unknown>
      | undefined;
    expect(assistantSidecar?.thoughtTokens).toBeUndefined();

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const preservedAssistant = loaded.records.find(
      (record) => record.type === "assistant_message" && record.uuid === "keep-assistant",
    );
    expect(
      preservedAssistant?.type === "assistant_message"
        ? preservedAssistant.usage?.thought_tokens
        : null,
    ).toBe(0);
    const modelText = sessionRecordsToMessages(loaded.modelRecords).flatMap((message) =>
      message.content.map((block) => (block.type === "text" ? block.text : "")),
    );
    expect(modelText.some((text) => text.includes("discarded before preserve"))).toBe(false);
    expect(modelText).toContain("preserved user");
    expect(modelText).toContain("preserved assistant");
    expect(modelText).toContain("after preserved compact");
  });

  it("keeps history for blank and missing legacy compact summaries", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });

    for (const summary of ["empty", "missing", "whitespace"] as const) {
      const lines = serializeFixtureRecords(cwd, [
        sessionMetaRecord(),
        {
          type: "user_message",
          ts: TS,
          uuid: "old-user",
          content: `history before legacy boundary ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
        },
        {
          type: "assistant_message",
          ts: TS,
          uuid: "old-assistant",
          content: "history answer before legacy boundary",
        },
        {
          type: "compaction_mark",
          ts: TS,
          uuid: "legacy-boundary",
          summary_ref: summary === "whitespace" ? "   " : "",
          trigger: "auto",
        },
        {
          type: "user_message",
          ts: TS,
          uuid: "post-user",
          content: "history after legacy boundary",
        },
      ]);
      if (summary === "missing") {
        const boundaryIndex = lines.findIndex((line) => line.includes('"legacy-boundary"'));
        const boundary = JSON.parse(lines[boundaryIndex]!) as Record<string, unknown>;
        const sidecar = boundary._os as { compaction?: Record<string, unknown> };
        delete sidecar.compaction?.summaryRef;
        lines[boundaryIndex] = JSON.stringify(boundary);
      }
      writeFileMock(path, lines.join("\n") + "\n");

      const loaded = await loadSessionForResume(SESSION_ID, cwd);
      const messages = sessionRecordsToMessages(loaded.modelRecords);
      const text = messages.flatMap((message) =>
        message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      );
      expect(text).toContain("history answer before legacy boundary");
      expect(text).toContain("history after legacy boundary");
    }
  });

  it("normalizes canonical and sidecar preserve metadata before planning", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });

    for (const representation of ["canonical", "sidecar"] as const) {
      const lines = preservedSession(cwd);
      const boundaryIndex = lines.findIndex((line) => line.includes('"uuid":"boundary"'));
      const boundary = JSON.parse(lines[boundaryIndex]!) as Record<string, unknown>;
      if (representation === "canonical") {
        delete (boundary._os as { compaction?: unknown }).compaction;
        boundary.content = "canonical preserve summary";
      } else {
        delete boundary.compactMetadata;
      }
      lines[boundaryIndex] = JSON.stringify(boundary);
      writeFileMock(path, lines.join("\n") + "\n");

      const activeLines = await readActiveChainLines(SESSION_ID);
      const uuids = activeLines.flatMap((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return typeof parsed.uuid === "string" ? [parsed.uuid] : [];
      });
      expect(uuids).toContain("keep-user");
      expect(uuids).toContain("keep-assistant");
      expect(uuids).toContain("discarded-user");
    }
  });

  it("uses the no-op plan when canonical preserve metadata has an invalid anchor", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = preservedSession(cwd);
    const boundaryIndex = lines.findIndex((line) => line.includes('"uuid":"boundary"'));
    const boundary = JSON.parse(lines[boundaryIndex]!) as Record<string, unknown>;
    delete (boundary._os as { compaction?: unknown }).compaction;
    boundary.content = "canonical preserve summary";
    const metadata = boundary.compactMetadata as Record<string, Record<string, unknown>>;
    metadata.preservedSegment!.anchorUuid = "not-the-boundary";
    metadata.preservedMessages!.anchorUuid = "not-the-boundary";
    lines[boundaryIndex] = JSON.stringify(boundary);
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const uuids = activeLines.flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return typeof parsed.uuid === "string" ? [parsed.uuid] : [];
    });

    expect(uuids).toContain("discarded-user");
    expect(uuids).toContain("keep-user");
    expect(uuids).toContain("post-user");

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const text = sessionRecordsToMessages(loaded.modelRecords).flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
    expect(text).toContain("preserved assistant");
    expect(text).toContain("after preserved compact");
  });

  it("keeps stale preserve history visible across a later hard boundary", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, stalePreserveSession(cwd).join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const uuids = activeLines.flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const isChainLine =
        parsed.type === "user" ||
        parsed.type === "assistant" ||
        (parsed.type === "system" && parsed.subtype === "compact_boundary");
      return typeof parsed.uuid === "string" && isChainLine ? [parsed.uuid] : [];
    });

    expect(uuids).toEqual([
      "discarded-user",
      "keep-user",
      "keep-assistant",
      "boundary",
      "preserve-post",
      "hard-boundary",
      "hard-post",
    ]);
  });

  it("round-trips preserve metadata on a compact boundary", () => {
    const chain = new SessionChain();
    const line = serializeRecord(
      {
        type: "compaction_mark",
        ts: TS,
        uuid: "boundary",
        summary_ref: "summary",
        preservedSegment: {
          headUuid: "keep-user",
          tailUuid: "keep-assistant",
          anchorUuid: "boundary",
        },
        preservedMessages: {
          uuids: ["keep-user", "keep-assistant"],
          anchorUuid: "boundary",
        },
      },
      chain,
      { sessionId: SESSION_ID, cwd: "/repo", version: "test" },
    );

    expect(lineToRecord(line)).toMatchObject({
      type: "compaction_mark",
      uuid: "boundary",
      preservedSegment: {
        headUuid: "keep-user",
        tailUuid: "keep-assistant",
        anchorUuid: "boundary",
      },
      preservedMessages: {
        uuids: ["keep-user", "keep-assistant"],
        anchorUuid: "boundary",
      },
    });
  });

  it("restores only the latest attribution snapshot from the active segment", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializedSession(cwd);
    lines.splice(
      3,
      0,
      JSON.stringify({ type: "attribution-snapshot", messageId: "before-boundary" }),
    );
    lines.splice(
      5,
      0,
      JSON.stringify({ type: "attribution-snapshot", messageId: "active-older" }),
      JSON.stringify({ type: "attribution-snapshot", messageId: "active-latest" }),
    );
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const snapshots = activeLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.type === "attribution-snapshot");

    expect(snapshots).toEqual([{ type: "attribution-snapshot", messageId: "active-latest" }]);
  });

  it("recovers latest session metadata from before a hard boundary", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializedSession(cwd);
    lines.splice(
      3,
      0,
      JSON.stringify({ type: "last-prompt", lastPrompt: "older prompt" }),
      JSON.stringify({ type: "attribution-snapshot", messageId: "older attribution" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "latest prompt" }),
      JSON.stringify({ type: "attribution-snapshot", messageId: "latest attribution" }),
    );
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const parsed = activeLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(parsed.filter((line) => line.subtype === "otherside-config")).toHaveLength(1);
    // An ordinary boundary replaces the history those markers describe:
    // pre-boundary last-prompt/attribution snapshots are never restored.
    expect(parsed.filter((line) => line.type === "last-prompt")).toEqual([]);
    expect(parsed.filter((line) => line.type === "attribution-snapshot")).toEqual([]);
  });

  it("filters stale metadata in a small transcript like the large-file path", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializedSession(cwd, false);
    lines.splice(
      3,
      0,
      JSON.stringify({
        type: "session_meta",
        ts: TS,
        cwd,
        provider: "codex",
        model: "stale-model",
      }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "stale prompt" }),
      JSON.stringify({ type: "attribution-snapshot", messageId: "stale attribution" }),
      JSON.stringify({
        type: "session_meta",
        ts: TS,
        cwd,
        provider: "codex",
        model: "latest-model",
      }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "latest prompt" }),
      JSON.stringify({ type: "attribution-snapshot", messageId: "latest attribution" }),
    );
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const parsed = activeLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const metadata = parsed.filter((line) => line.type === "session_meta");
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ model: "latest-model" });
    // Pre-boundary last-prompt/attribution markers describe replaced history
    // and drop at an ordinary boundary, exactly like the large-file path.
    expect(parsed.filter((line) => line.type === "last-prompt")).toEqual([]);
    expect(parsed.filter((line) => line.type === "attribution-snapshot")).toEqual([]);
  });

  it("keeps pre-boundary history in a small transcript while the model input stays cut", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(cwd, false).join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const text = activeLines.join("\n");
    expect(text).toContain("before compact");
    expect(text).toContain("before answer");
    expect(text).toContain("after compact");

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const modelText = sessionRecordsToMessages(loaded.modelRecords).flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    );
    expect(modelText.some((entry) => entry.includes("before compact"))).toBe(false);
    expect(modelText.some((entry) => entry.includes("after compact"))).toBe(true);
  });

  it("renders pre-boundary task notifications from a large transcript", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const notification =
      '<task-notification>\n<task-id>agent-9</task-id>\n<status>failed</status>\n<summary>Agent "Old work" failed · 12m</summary>\n</task-notification>';
    const lines = serializeFixtureRecords(cwd, [
      sessionMetaRecord(),
      {
        type: "user_message",
        ts: TS,
        content: `before compact ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
      },
      {
        type: "attachment",
        ts: TS,
        attachment: {
          type: "queued_command",
          prompt: notification,
          commandMode: "task-notification",
          isMeta: true,
        },
      },
      { type: "compaction_mark", ts: TS, summary_ref: "summary", trigger: "auto" },
      { type: "user_message", ts: TS, content: "after compact" },
    ]);
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    expect(activeLines).toEqual(await readMainChainLines(SESSION_ID));
    // The pre-boundary notification attachment survives the full-scope read;
    // its structured projection is asserted in the transcript-layer tests.
    const kept = recordsFromLines(activeLines).find(
      (record) =>
        record.type === "attachment" &&
        record.attachment.type === "queued_command" &&
        record.attachment.commandMode === "task-notification",
    );
    const prompt =
      kept?.type === "attachment" && kept.attachment.type === "queued_command"
        ? kept.attachment.prompt
        : "";
    expect(prompt).toContain("<task-id>agent-9</task-id>");
    expect(prompt).toContain('Agent "Old work" failed · 12m');
  });

  it("keeps pre-preserve history in a small transcript with a preserved tail", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = serializeFixtureRecords(cwd, [
      sessionMetaRecord(),
      { type: "user_message", ts: TS, uuid: "early-user", content: "early history" },
      { type: "user_message", ts: TS, uuid: "keep-user", content: "preserved user" },
      {
        type: "assistant_message",
        ts: TS,
        uuid: "keep-assistant",
        content: "preserved assistant",
        provider: "codex",
        model: "gpt-5.5",
      },
      {
        type: "compaction_mark",
        ts: TS,
        uuid: "boundary",
        summary_ref: "summary with preserve",
        trigger: "auto",
        preservedSegment: {
          headUuid: "keep-user",
          tailUuid: "keep-assistant",
          anchorUuid: "boundary",
        },
      },
      { type: "user_message", ts: TS, uuid: "post-user", content: "after preserved compact" },
    ]);
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const uuids = activeLines.flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return typeof parsed.uuid === "string" ? [parsed.uuid] : [];
    });
    expect(uuids).toContain("early-user");
    expect(uuids).toContain("keep-user");
    expect(uuids).toContain("keep-assistant");
    expect(uuids).toContain("post-user");

    const byUuid = new Map(
      activeLines.map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return [parsed.uuid, parsed] as const;
      }),
    );
    expect(byUuid.get("keep-user")?.parentUuid).toBe("boundary");
    expect(byUuid.get("keep-assistant")?.parentUuid).toBe("keep-user");
  });

  it("drops unselected branches before parsing a large transcript", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    const lines = [
      nativeConfigLine(cwd),
      nativeUserLine("root", null, `root ${"x".repeat(BIG_PRECOMPACT_TEXT)}`),
      nativeUserLine("dead", "root", "dead branch"),
      nativeUserLine("active-one", "root", "active branch"),
      nativeUserLine("active-two", "active-one", "active leaf"),
      nativeUserLine("newer-dead", "dead", "newer dead branch"),
      JSON.stringify({ type: "last-prompt", leafUuid: "active-two", lastPrompt: "active leaf" }),
    ];
    writeFileMock(path, lines.join("\n") + "\n");

    const activeLines = await readActiveChainLines(SESSION_ID);
    const userUuids = activeLines.flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed.type === "user" && typeof parsed.uuid === "string" ? [parsed.uuid] : [];
    });

    expect(userUuids).toEqual(["root", "active-one", "active-two"]);
  });

  it("loads the full large transcript when active-segment skipping is disabled", async () => {
    process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP = "yes";
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(cwd).join("\n") + "\n");

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const userMessages = loaded.records.filter((record) => record.type === "user_message");

    expect(userMessages).toHaveLength(2);
  });

  it("does not disable active-segment skipping for false-like env values", async () => {
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(path, serializedSession(cwd).join("\n") + "\n");

    for (const value of ["0", "false"]) {
      process.env.OTHERSIDE_DISABLE_PRECOMPACT_SKIP = value;
      const loaded = await loadSessionForResume(SESSION_ID, cwd);
      const userMessages = loaded.records.filter((record) => record.type === "user_message");
      expect(userMessages).toHaveLength(2);
    }
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

  it("restores broker state from a head session_meta older than the typed tail", async () => {
    // Large-file resume only fully types the tail window; the latest broker
    // sidecar may live in the head summary. Shrink the tail window so the early
    // session_meta is forced into the head path.
    process.env.OTHERSIDE_RESUME_TAIL_ENTRIES = "1";
    const cwd = join(base, "repo");
    const path = sessionPathForCwd(cwd, SESSION_ID);
    mkdirMock(dirname(path), { recursive: true });
    writeFileMock(
      path,
      serializeFixtureRecords(cwd, [
        {
          type: "session_meta",
          ts: TS,
          cwd,
          provider: "codex",
          model: "gpt-5.5",
          effort: "xhigh",
          fastMode: true,
          ultracode: true,
        },
        {
          type: "user_message",
          ts: TS,
          uuid: "head-user",
          content: `head history ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
        },
        {
          type: "assistant_message",
          ts: TS,
          uuid: "head-assistant",
          content: "head answer",
        },
        {
          type: "user_message",
          ts: TS,
          uuid: "tail-user",
          content: "tail only message",
        },
      ]).join("\n") + "\n",
    );

    const loaded = await loadSessionForResume(SESSION_ID, cwd);
    const headMeta = loaded.records.find((record) => record.type === "session_meta");
    expect(headMeta).toMatchObject({
      type: "session_meta",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      fastMode: true,
      ultracode: true,
    });
    // Transcript projection input is capped to the tail window.
    const tailUsers = loaded.tailRecords.filter((record) => record.type === "user_message");
    expect(tailUsers).toHaveLength(1);
    expect(tailUsers[0]).toMatchObject({ uuid: "tail-user", content: "tail only message" });

    const restored = resolveSessionBrokerState(loaded.records, {
      provider: "anthropic",
      model: "claude-fable-5",
      effort: "high",
      fastMode: false,
      ultracode: false,
    });
    // Head session_meta is the restore source even when the typed tail is a
    // single later message. Provider/model/fastMode/ultracode come from that
    // sidecar; effort may fall back to the model default when later lines restate
    // provider/model without an effort field.
    expect(restored.provider).toBe("codex");
    expect(restored.model).toBe("gpt-5.5");
    expect(restored.fastMode).toBe(true);
    expect(restored.ultracode).toBe(true);
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

function serializedSession(cwd: string, includeLargeHistory = true): string[] {
  const chain = new SessionChain();
  const stamp = { sessionId: SESSION_ID, cwd, version: "test" };
  return records(includeLargeHistory).map((record) => serializeRecord(record, chain, stamp));
}

function records(includeLargeHistory = true): SessionRecord[] {
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
      content: `before compact ${includeLargeHistory ? "x".repeat(BIG_PRECOMPACT_TEXT) : ""}`,
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

function preservedSession(cwd: string): string[] {
  return serializeFixtureRecords(cwd, [
    sessionMetaRecord(),
    {
      type: "user_message",
      ts: TS,
      uuid: "discarded-user",
      content: `discarded before preserve ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
    },
    {
      type: "user_message",
      ts: TS,
      uuid: "keep-user",
      content: "preserved user",
    },
    {
      type: "assistant_message",
      ts: TS,
      uuid: "keep-assistant",
      content: "preserved assistant",
      provider: "codex",
      model: "gpt-5.5",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        thought_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
        request_count: 1,
      },
    },
    preserveBoundaryRecord(),
    {
      type: "user_message",
      ts: TS,
      uuid: "post-user",
      content: "after preserved compact",
    },
  ]);
}

function stalePreserveSession(cwd: string): string[] {
  return serializeFixtureRecords(cwd, [
    sessionMetaRecord(),
    {
      type: "user_message",
      ts: TS,
      uuid: "discarded-user",
      content: `discarded before preserve ${"x".repeat(BIG_PRECOMPACT_TEXT)}`,
    },
    {
      type: "user_message",
      ts: TS,
      uuid: "keep-user",
      content: "preserved user",
    },
    {
      type: "assistant_message",
      ts: TS,
      uuid: "keep-assistant",
      content: "preserved assistant",
      provider: "codex",
      model: "gpt-5.5",
    },
    preserveBoundaryRecord(),
    {
      type: "user_message",
      ts: TS,
      uuid: "preserve-post",
      content: "after preserved compact",
    },
    {
      type: "compaction_mark",
      ts: TS,
      uuid: "hard-boundary",
      summary_ref: "hard boundary summary",
      trigger: "manual",
    },
    {
      type: "user_message",
      ts: TS,
      uuid: "hard-post",
      content: "after hard compact",
    },
  ]);
}

function sessionMetaRecord(): SessionRecord {
  return {
    type: "session_meta",
    ts: TS,
    cwd: "unused",
    provider: "codex",
    model: "gpt-5.5",
  };
}

function preserveBoundaryRecord(): SessionRecord {
  return {
    type: "compaction_mark",
    ts: TS,
    uuid: "boundary",
    summary_ref: "preserved boundary summary",
    trigger: "auto",
    preservedSegment: {
      headUuid: "keep-user",
      tailUuid: "keep-assistant",
      anchorUuid: "boundary",
    },
    preservedMessages: {
      uuids: ["keep-user", "keep-assistant"],
      anchorUuid: "boundary",
    },
  };
}

function serializeFixtureRecords(cwd: string, fixtureRecords: SessionRecord[]): string[] {
  const chain = new SessionChain();
  const stamp = { sessionId: SESSION_ID, cwd, version: "test" };
  return fixtureRecords.map((record) => serializeRecord(record, chain, stamp));
}

function nativeConfigLine(cwd: string): string {
  return serializeFixtureRecords(cwd, [sessionMetaRecord()])[0]!;
}

function nativeUserLine(uuid: string, parentUuid: string | null, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    timestamp: TS,
    message: { role: "user", content: [{ type: "text", text }] },
    _os: {},
  });
}
