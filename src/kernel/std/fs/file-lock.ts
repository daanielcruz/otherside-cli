import {
  closeSync,
  futimesSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isErrno } from "@/kernel/std/errno.ts";

const DEFAULT_RETRY_MS = 50;
const DEFAULT_MAX_WAIT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;

interface LockMeta {
  owner: string;
  pid: number;
}

interface LockLease extends LockMeta {
  descriptor: number;
  path: string;
}

interface FileLockOptions {
  retryMs?: number;
  maxWaitMs?: number;
  staleAfterMs?: number;
  updateMs?: number;
  onCompromised?: (error: Error) => void;
}

function lockPath(target: string): string {
  return `${target}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function readLockMeta(path: string): LockMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockMeta>;
    if (typeof parsed.owner !== "string" || typeof parsed.pid !== "number") return null;
    return { owner: parsed.owner, pid: parsed.pid };
  } catch {
    return null;
  }
}

function tryCreateExclusive(path: string): LockLease | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "wx");
    const lease: LockLease = {
      descriptor,
      owner: crypto.randomUUID(),
      path,
      pid: process.pid,
    };
    writeSync(descriptor, JSON.stringify({ owner: lease.owner, pid: lease.pid }));
    return lease;
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
      unlinkSafe(path);
    }
    if (!isErrno(error, "EEXIST")) throw error;
    return null;
  }
}

function lockAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function unlinkSafe(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

function discardLock(path: string): boolean {
  const displaced = `${path}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    renameSync(path, displaced);
    unlinkSafe(displaced);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function tryAcquire(target: string, staleAfterMs: number): LockLease | null {
  const path = lockPath(target);
  const lease = tryCreateExclusive(path);
  if (lease) return lease;

  const meta = readLockMeta(path);
  const age = lockAgeMs(path);
  const ownerExited = meta ? !isProcessAlive(meta.pid) : false;
  const stale = age !== null && age > staleAfterMs;
  if (!ownerExited && !stale) return null;
  if (!discardLock(path)) return null;
  return tryCreateExclusive(path);
}

function ownsLease(lease: LockLease): boolean {
  return readLockMeta(lease.path)?.owner === lease.owner;
}

function releaseLease(lease: LockLease): void {
  if (ownsLease(lease)) unlinkSafe(lease.path);
  try {
    closeSync(lease.descriptor);
  } catch {}
}

function monitorLease(lease: LockLease, options: FileLockOptions): () => void {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const updateMs = options.updateMs ?? Math.max(1, Math.floor(staleAfterMs / 3));
  let compromised = false;
  const markCompromised = (): void => {
    if (compromised) return;
    compromised = true;
    options.onCompromised?.(new Error(`file lock compromised: ${lease.path}`));
  };
  const update = (): void => {
    if (!ownsLease(lease)) {
      markCompromised();
      return;
    }
    try {
      const now = new Date();
      futimesSync(lease.descriptor, now, now);
    } catch {
      markCompromised();
    }
  };
  const interval = setInterval(update, updateMs);
  // On Windows the runtime does not fire unref'd timers while no other ref'd
  // handle is active, which would silence compromise detection during
  // pure-await critical sections. The monitor stays ref'd there; release
  // clears it, so a completed lock never holds the process open.
  if (process.platform !== "win32") interval.unref();
  return () => {
    clearInterval(interval);
    if (!ownsLease(lease)) markCompromised();
    releaseLease(lease);
  };
}

function sleepBlocking(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

export function withFileLockSync<T>(target: string, fn: () => T, options?: FileLockOptions): T {
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + maxWaitMs;
  let lease: LockLease | null = null;
  while (!lease) {
    lease = tryAcquire(target, staleAfterMs);
    if (lease) break;
    if (Date.now() >= deadline) throw new Error(`file lock timeout: ${target}`);
    sleepBlocking(retryMs);
  }
  try {
    return fn();
  } finally {
    releaseLease(lease);
  }
}

export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + maxWaitMs;
  let lease: LockLease | null = null;
  while (!lease) {
    lease = tryAcquire(target, staleAfterMs);
    if (lease) break;
    if (Date.now() >= deadline) throw new Error(`file lock timeout: ${target}`);
    await Bun.sleep(retryMs);
  }
  const stopMonitoring = monitorLease(lease, options ?? {});
  try {
    return await fn();
  } finally {
    stopMonitoring();
  }
}
