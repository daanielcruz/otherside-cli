import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isErrno } from "@/kernel/std/errno.ts";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { sessionRegistryDir } from "@/kernel/std/fs/paths.ts";

export type SessionStatus = "busy" | "idle";

export interface SessionRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
}

const STALE_AFTER_MS = 60_000;

function entryPath(sessionId: string): string {
  return join(sessionRegistryDir(), `${sessionId}.json`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrno(err, "EPERM");
  }
}

export function isSessionAlive(sessionId: string): boolean {
  const entry = readEntry(sessionId);
  if (entry === null) return false;
  return isProcessAlive(entry.pid);
}

export function registerSession(sessionId: string, cwd: string): void {
  const now = Date.now();
  const entry: SessionRegistryEntry = {
    pid: process.pid,
    sessionId,
    cwd,
    status: "idle",
    startedAt: now,
    updatedAt: now,
  };
  writeEntry(entry);
}

export function updateSessionStatus(sessionId: string, cwd: string, status: SessionStatus): void {
  const existing = readEntry(sessionId);
  const now = Date.now();
  const entry: SessionRegistryEntry = {
    pid: process.pid,
    sessionId,
    cwd,
    status,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  writeEntry(entry);
}

export function touchSession(sessionId: string, cwd: string): void {
  const existing = readEntry(sessionId);
  updateSessionStatus(sessionId, cwd, existing?.status ?? "idle");
}

export function unregisterSession(sessionId: string): void {
  try {
    unlinkSync(entryPath(sessionId));
  } catch {}
}

export function liveSessionsForCwd(cwd: string): SessionRegistryEntry[] {
  const dir = sessionRegistryDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionRegistryEntry[] = [];
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sessionId = name.slice(0, -".json".length);
    const entry = readEntry(sessionId);
    if (!entry) continue;
    const stale = now - entry.updatedAt > STALE_AFTER_MS;
    if (!isProcessAlive(entry.pid) || stale) {
      unregisterSession(sessionId);
      continue;
    }
    if (entry.pid === process.pid) continue;
    if (entry.cwd === cwd) out.push(entry);
  }
  return out;
}

function writeEntry(entry: SessionRegistryEntry): void {
  const path = entryPath(entry.sessionId);
  try {
    mkdirSync(sessionRegistryDir(), { recursive: true });
    withFileLockSync(path, () => {
      writeFileSync(path, JSON.stringify(entry), "utf8");
    });
  } catch {}
}

function readEntry(sessionId: string): SessionRegistryEntry | null {
  const path = entryPath(sessionId);
  try {
    statSync(path);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionRegistryEntry>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.cwd !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      status: parsed.status === "busy" ? "busy" : "idle",
      startedAt: parsed.startedAt ?? Date.now(),
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}
