import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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
fsMock[`readFile${S}`] = (p: string, options?: unknown) => readFileMock(p, options);
fsMock[`utimes${S}`] = (p: string, atime: number | string | Date, mtime: number | string | Date) =>
  utimesMock(p, atime, mtime);
fsMock[`unlink${S}`] = (p: string) => unlinkMock(p);
fsMock[`open${S}`] = (p: string, flags?: string) => {
  const norm = normalize(p);
  if (flags?.includes("x") && existsMock(norm)) {
    const err = new Error(`EEXIST: file already exists, open '${p}'`);
    (err as unknown as Record<string, unknown>).code = "EEXIST";
    throw err;
  }
  if (!existsMock(norm)) {
    writeFileMock(norm, "");
  }
  return norm;
};
fsMock[`write${S}`] = (fd: unknown, content: string | Buffer) => {
  writeFileMock(fd as string, content);
};
fsMock[`close${S}`] = (_fd: unknown) => {};

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
}));

import { sweepToolResultsBudget } from "../retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let base: string;
let savedConfigDir: string | undefined;
let savedEphemeralDir: string | undefined;
let savedBudget: string | undefined;

function spillFile(name: string, bytes: number, mtimeMs: number): string {
  const dir = join(base, "config", "projects", "-slug", "session-uuid", "tool-results");
  mkdirMock(dir, { recursive: true });
  const path = join(dir, name);
  writeFileMock(path, "x".repeat(bytes));
  const seconds = mtimeMs / 1000;
  utimesMock(path, seconds, seconds);
  return path;
}

beforeEach(() => {
  mockFs.clear();
  base = mkdtempMock("otherside-retention-");
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  savedEphemeralDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  savedBudget = process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES;
  process.env.OTHERSIDE_CONFIG_DIR = join(base, "config");
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(base, "ephemeral");
});

afterEach(() => {
  restoreEnv("OTHERSIDE_CONFIG_DIR", savedConfigDir);
  restoreEnv("OTHERSIDE_EPHEMERAL_SESSIONS_DIR", savedEphemeralDir);
  restoreEnv("OTHERSIDE_TOOL_RESULTS_MAX_BYTES", savedBudget);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("sweepToolResultsBudget", () => {
  it("evicts oldest spill files until under the byte budget", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "100";
    const oldest = spillFile("oldest.txt", 60, NOW - 3 * DAY_MS);
    const older = spillFile("older.txt", 60, NOW - 2 * DAY_MS);
    const fresh = spillFile("fresh.txt", 60, NOW);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(oldest)).toBe(false);
    expect(existsMock(older)).toBe(false);
    expect(existsMock(fresh)).toBe(true);
  });

  it("never evicts files written within the fresh window", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "10";
    const freshA = spillFile("a.txt", 60, NOW);
    const freshB = spillFile("b.txt", 60, NOW - DAY_MS / 2);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(freshA)).toBe(true);
    expect(existsMock(freshB)).toBe(true);
  });

  it("keeps everything when total is under budget", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "1000";
    const file = spillFile("keep.txt", 60, NOW - 5 * DAY_MS);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(file)).toBe(true);
  });

  it("is disabled when the budget is set to zero", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "0";
    const file = spillFile("keep.txt", 600, NOW - 5 * DAY_MS);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(file)).toBe(true);
  });
});

describe("retention hardening", () => {
  it("evicts files older than absolute TTL even when under budget", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "1000";
    process.env.OTHERSIDE_TOOL_RESULTS_TTL_DAYS = "7";
    const oldFile = spillFile("old-ttl.txt", 60, NOW - 8 * DAY_MS);
    const freshFile = spillFile("fresh-ttl.txt", 60, NOW - 6 * DAY_MS);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(oldFile)).toBe(false);
    expect(existsMock(freshFile)).toBe(true);
  });

  it("does not evict tool results files of active sessions", async () => {
    process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES = "10";
    process.env.OTHERSIDE_TOOL_RESULTS_TTL_DAYS = "1";

    const activeSessionId = "active-session-uuid";
    const regDir = join(base, "config", "session-registry");
    mkdirMock(regDir, { recursive: true });
    writeFileMock(
      join(regDir, `${activeSessionId}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: activeSessionId,
        cwd: base,
        status: "idle",
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );

    const activeSessionSpillDir = join(
      base,
      "config",
      "projects",
      "-slug",
      activeSessionId,
      "tool-results",
    );
    mkdirMock(activeSessionSpillDir, { recursive: true });
    const path = join(activeSessionSpillDir, "spill.txt");
    writeFileMock(path, "x".repeat(60));
    const seconds = (NOW - 10 * DAY_MS) / 1000;
    utimesMock(path, seconds, seconds);

    await sweepToolResultsBudget(NOW);

    expect(existsMock(path)).toBe(true);
  });

  it("excludes active sessions from project/ephemeral session sweeping", async () => {
    const activeSessionId = "a53a6eb2-9b2f-410a-ba5e-2f9a76d8b9d3";
    const inactiveSessionId = "b63a6eb2-9b2f-410a-ba5e-2f9a76d8b9d4";

    const regDir = join(base, "config", "session-registry");
    mkdirMock(regDir, { recursive: true });
    writeFileMock(
      join(regDir, `${activeSessionId}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: activeSessionId,
        cwd: base,
        status: "idle",
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );

    const projectSlugDir = join(base, "config", "projects", "my-project-slug");
    mkdirMock(projectSlugDir, { recursive: true });

    const activeSessionDir = join(projectSlugDir, activeSessionId);
    mkdirMock(activeSessionDir, { recursive: true });
    const activeFile = join(activeSessionDir, "some-data.json");
    writeFileMock(activeFile, "data");
    utimesMock(activeSessionDir, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);
    utimesMock(activeFile, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);

    const activeJsonl = join(projectSlugDir, `${activeSessionId}.jsonl`);
    writeFileMock(activeJsonl, "history");
    utimesMock(activeJsonl, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);

    const inactiveSessionDir = join(projectSlugDir, inactiveSessionId);
    mkdirMock(inactiveSessionDir, { recursive: true });
    const inactiveFile = join(inactiveSessionDir, "some-data.json");
    writeFileMock(inactiveFile, "data");
    utimesMock(inactiveSessionDir, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);
    utimesMock(inactiveFile, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);

    const inactiveJsonl = join(projectSlugDir, `${inactiveSessionId}.jsonl`);
    writeFileMock(inactiveJsonl, "history");
    utimesMock(inactiveJsonl, (NOW - 40 * DAY_MS) / 1000, (NOW - 40 * DAY_MS) / 1000);

    const { runRetentionCleanup } = await import("../retention.ts");
    await runRetentionCleanup(NOW);

    expect(existsMock(inactiveSessionDir)).toBe(false);
    expect(existsMock(inactiveJsonl)).toBe(false);

    expect(existsMock(activeSessionDir)).toBe(true);
    expect(existsMock(activeFile)).toBe(true);
    expect(existsMock(activeJsonl)).toBe(true);
  });

  it("sweeps orphan task-list directories under the config tasks root by retention age", async () => {
    const liveSessionId = "e93a6eb2-9b2f-410a-ba5e-2f9a76d8b9d7";
    const regDir = join(base, "config", "session-registry");
    mkdirMock(regDir, { recursive: true });
    writeFileMock(
      join(regDir, `${liveSessionId}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: liveSessionId,
        cwd: base,
        status: "idle",
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );

    const tasksRoot = join(base, "config", "tasks");
    const seed = (name: string, ageMs: number): string => {
      const dir = join(tasksRoot, name);
      mkdirMock(dir, { recursive: true });
      const file = join(dir, "1");
      writeFileMock(file, JSON.stringify({ id: "1", subject: "s" }));
      const seconds = (NOW - ageMs) / 1000;
      utimesMock(file, seconds, seconds);
      utimesMock(dir, seconds, seconds);
      return dir;
    };
    // Orphans from dead sessions: a stale session-id list and a stale
    // agent-scoped list both age out; a fresh one and a live session's list stay.
    const staleSessionList = seed("f13a6eb2-9b2f-410a-ba5e-2f9a76d8b9d8", 40 * DAY_MS);
    const staleAgentList = seed("agent-list-stale", 40 * DAY_MS);
    const freshList = seed("agent-list-fresh", 1 * DAY_MS);
    const liveSessionList = seed(liveSessionId, 40 * DAY_MS);

    const { runRetentionCleanup } = await import("../retention.ts");
    await runRetentionCleanup(NOW);

    expect(existsMock(staleSessionList)).toBe(false);
    expect(existsMock(staleAgentList)).toBe(false);
    expect(existsMock(freshList)).toBe(true);
    expect(existsMock(liveSessionList)).toBe(true);
  });

  it("prunes orphan task directories in tmp while preserving active ones by PID, registry, and mtime", async () => {
    const tmpDir = join(base, "tmp");
    mkdirMock(tmpDir, { recursive: true });

    const activeSessionId = "c73a6eb2-9b2f-410a-ba5e-2f9a76d8b9d5";
    const inactiveSessionId = "d83a6eb2-9b2f-410a-ba5e-2f9a76d8b9d6";

    const regDir = join(base, "config", "session-registry");
    mkdirMock(regDir, { recursive: true });
    writeFileMock(
      join(regDir, `${activeSessionId}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: activeSessionId,
        cwd: base,
        status: "idle",
        startedAt: NOW,
        updatedAt: NOW,
      }),
    );

    const runningPidDir = join(tmpDir, "otherside-1", "default", `pid-${process.pid}`, "tasks");
    mkdirMock(runningPidDir, { recursive: true });
    const file1 = join(runningPidDir, "task-1.log");
    writeFileMock(file1, "log");
    utimesMock(file1, (NOW - 2 * 60 * 60 * 1000) / 1000, (NOW - 2 * 60 * 60 * 1000) / 1000);
    utimesMock(
      join(tmpDir, "otherside-1", "default", `pid-${process.pid}`),
      (NOW - 2 * 60 * 60 * 1000) / 1000,
      (NOW - 2 * 60 * 60 * 1000) / 1000,
    );
    utimesMock(
      join(tmpDir, "otherside-1"),
      (NOW - 2 * 60 * 60 * 1000) / 1000,
      (NOW - 2 * 60 * 60 * 1000) / 1000,
    );

    const deadPid = 999999;
    const default2 = join(tmpDir, "otherside-2", "default");
    const pid2Dir = join(default2, `pid-${deadPid}`);
    const deadPidDir = join(pid2Dir, "tasks");
    mkdirMock(deadPidDir, { recursive: true });
    const file2 = join(deadPidDir, "task-2.log");
    writeFileMock(file2, "log");
    const t = (NOW - 2 * 60 * 60 * 1000) / 1000;
    utimesMock(join(tmpDir, "otherside-2"), t, t);
    utimesMock(default2, t, t);
    utimesMock(pid2Dir, t, t);
    utimesMock(deadPidDir, t, t);
    utimesMock(file2, t, t);

    const activeSessDir = join(tmpDir, "otherside-3", "project-slug", activeSessionId, "tasks");
    mkdirMock(activeSessDir, { recursive: true });
    const file3 = join(activeSessDir, "task-3.log");
    writeFileMock(file3, "log");
    utimesMock(file3, (NOW - 2 * 60 * 60 * 1000) / 1000, (NOW - 2 * 60 * 60 * 1000) / 1000);
    utimesMock(activeSessDir, (NOW - 2 * 60 * 60 * 1000) / 1000, (NOW - 2 * 60 * 60 * 1000) / 1000);
    utimesMock(
      join(tmpDir, "otherside-3"),
      (NOW - 2 * 60 * 60 * 1000) / 1000,
      (NOW - 2 * 60 * 60 * 1000) / 1000,
    );

    const proj4 = join(tmpDir, "otherside-4", "project-slug");
    const sess4Dir = join(proj4, inactiveSessionId);
    const inactiveSessDir = join(sess4Dir, "tasks");
    mkdirMock(inactiveSessDir, { recursive: true });
    const file4 = join(inactiveSessDir, "task-4.log");
    writeFileMock(file4, "log");
    utimesMock(join(tmpDir, "otherside-4"), t, t);
    utimesMock(proj4, t, t);
    utimesMock(sess4Dir, t, t);
    utimesMock(inactiveSessDir, t, t);
    utimesMock(file4, t, t);

    const freshDir = join(tmpDir, "otherside-5", "default", `pid-${deadPid}`, "tasks");
    mkdirMock(freshDir, { recursive: true });
    const file5 = join(freshDir, "task-5.log");
    writeFileMock(file5, "log");
    utimesMock(file5, (NOW - 10 * 60 * 1000) / 1000, (NOW - 10 * 60 * 1000) / 1000);
    utimesMock(freshDir, (NOW - 10 * 60 * 1000) / 1000, (NOW - 10 * 60 * 1000) / 1000);
    utimesMock(
      join(tmpDir, "otherside-5"),
      (NOW - 10 * 60 * 1000) / 1000,
      (NOW - 10 * 60 * 1000) / 1000,
    );

    const { pruneOrphanTaskDirs } = await import("../retention.ts");
    await pruneOrphanTaskDirs(NOW, tmpDir);

    expect(existsMock(join(tmpDir, "otherside-1"))).toBe(true);
    expect(existsMock(join(tmpDir, "otherside-2"))).toBe(false);
    expect(existsMock(join(tmpDir, "otherside-3"))).toBe(true);
    expect(existsMock(join(tmpDir, "otherside-4"))).toBe(false);
    expect(existsMock(join(tmpDir, "otherside-5"))).toBe(true);
  });

  afterAll(() => {
    mock.module("node:fs", () => originalFs);
    mock.module("node:fs/promises", () => originalFsPromises);
  });
});
