import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { isErrno } from "@/kernel/std/errno.ts";

const DEFAULT_RETRY_MS = 50;
const DEFAULT_MAX_WAIT_MS = 5_000;
const STALE_AFTER_MS = 30_000;

interface LockMeta {
  pid: number;
  acquiredAt: number;
}

function lockPath(target: string): string {
  return `${target}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrno(err, "EPERM");
  }
}

function readLockMeta(path: string): LockMeta | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") return null;
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function tryCreateExclusive(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    const meta: LockMeta = { pid: process.pid, acquiredAt: Date.now() };
    writeSync(fd, JSON.stringify(meta));
    closeSync(fd);
    return true;
  } catch (err) {
    if (!isErrno(err, "EEXIST")) throw err;
    return false;
  }
}

function lockfileAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function tryAcquire(target: string): boolean {
  const path = lockPath(target);
  if (tryCreateExclusive(path)) return true;
  const meta = readLockMeta(path);
  if (meta) {
    const age = Date.now() - meta.acquiredAt;
    if (meta.pid !== process.pid && isProcessAlive(meta.pid) && age <= STALE_AFTER_MS) return false;
    unlinkSafe(path);
    return tryCreateExclusive(path);
  }
  const age = lockfileAgeMs(path);
  if (age === null) return tryCreateExclusive(path);
  if (age <= STALE_AFTER_MS) return false;
  unlinkSafe(path);
  return tryCreateExclusive(path);
}

function unlinkSafe(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function sleepBlocking(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

export function withFileLockSync<T>(
  target: string,
  fn: () => T,
  opts?: { retryMs?: number; maxWaitMs?: number },
): T {
  const retryMs = opts?.retryMs ?? DEFAULT_RETRY_MS;
  const maxWait = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const deadline = Date.now() + maxWait;
  while (!tryAcquire(target)) {
    if (Date.now() >= deadline) {
      throw new Error(`file lock timeout: ${target}`);
    }
    sleepBlocking(retryMs);
  }
  try {
    return fn();
  } finally {
    unlinkSafe(lockPath(target));
  }
}

export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T> | T,
  opts?: { retryMs?: number; maxWaitMs?: number },
): Promise<T> {
  const retryMs = opts?.retryMs ?? DEFAULT_RETRY_MS;
  const maxWait = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const deadline = Date.now() + maxWait;
  while (!tryAcquire(target)) {
    if (Date.now() >= deadline) {
      throw new Error(`file lock timeout: ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  try {
    return await fn();
  } finally {
    unlinkSafe(lockPath(target));
  }
}
