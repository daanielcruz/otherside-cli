import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearFileHistoryForSession,
  recordFileMutationResult,
  restoreFilesForRewind,
  setActiveRewindTurn,
  snapshotBeforeFileMutation,
} from "../file-history.ts";

const dirs: string[] = [];
const sessions: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
  dirs.push(dir);
  return dir;
}

function newSession(id: string): string {
  sessions.push(id);
  return id;
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    setActiveRewindTurn(id, null);
    clearFileHistoryForSession(id);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restoreFilesForRewind external-modification guard", () => {
  test("restores a file this session last wrote", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "original");
    const sessionId = newSession("fh-own-session");
    setActiveRewindTurn(sessionId, "t1");
    await snapshotBeforeFileMutation({ sessionId }, file);
    writeFileSync(file, "edited by this session");
    recordFileMutationResult({ sessionId }, file);

    const result = restoreFilesForRewind(sessionId, ["t1"]);
    expect(result.filesRestored).toBe(1);
    expect(result.skippedExternallyModified).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("skips a file another session modified after our last write", async () => {
    const dir = tempDir();
    const file = join(dir, "b.txt");
    writeFileSync(file, "original");
    const sessionId = newSession("fh-guard-session");
    setActiveRewindTurn(sessionId, "t1");
    await snapshotBeforeFileMutation({ sessionId }, file);
    writeFileSync(file, "edited by this session");
    recordFileMutationResult({ sessionId }, file);
    // Concurrent session writes AFTER our tracked mutation.
    writeFileSync(file, "edited by ANOTHER session");

    const result = restoreFilesForRewind(sessionId, ["t1"]);
    expect(result.skippedExternallyModified).toEqual([file]);
    expect(result.filesRestored).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("edited by ANOTHER session");
  });

  test("untracked files keep the plain overwrite behavior", async () => {
    const dir = tempDir();
    const file = join(dir, "c.txt");
    writeFileSync(file, "original");
    const sessionId = newSession("fh-untracked-session");
    setActiveRewindTurn(sessionId, "t1");
    await snapshotBeforeFileMutation({ sessionId }, file);
    // No recordFileMutationResult (e.g. mutation path without post-write hook).
    writeFileSync(file, "changed on disk");

    const result = restoreFilesForRewind(sessionId, ["t1"]);
    expect(result.filesRestored).toBe(1);
    expect(result.skippedExternallyModified).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("disk already at the restore target does not count as foreign", async () => {
    const dir = tempDir();
    const file = join(dir, "d.txt");
    writeFileSync(file, "original");
    const sessionId = newSession("fh-target-session");
    setActiveRewindTurn(sessionId, "t1");
    await snapshotBeforeFileMutation({ sessionId }, file);
    writeFileSync(file, "edited by this session");
    recordFileMutationResult({ sessionId }, file);
    // Someone (or a previous restore) already put the file back.
    writeFileSync(file, "original");

    const result = restoreFilesForRewind(sessionId, ["t1"]);
    expect(result.skippedExternallyModified).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });
});
