import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const worktreeLocks = new Map<string, Promise<void>>();
const FILESYSTEM_LOCK_TIMEOUT_MS = 30_000;
const FILESYSTEM_LOCK_STALE_MS = 60 * 60 * 1000;

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function acquireFilesystemLock(key: string): Promise<() => Promise<void>> {
  const lockPath = `${key}.lock`;
  const ownerPath = join(lockPath, "owner");
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + FILESYSTEM_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      // Publish an ownership token so a superseded holder — one whose lock was
      // taken as stale and re-created by another process — cannot delete the new
      // owner's lock when it finally releases.
      let ownershipPublished = true;
      try {
        await writeFile(ownerPath, token, "utf-8");
      } catch {
        ownershipPublished = false;
      }
      return async () => {
        if (!ownershipPublished) {
          await rm(lockPath, { recursive: true, force: true });
          return;
        }
        try {
          if ((await readFile(ownerPath, "utf-8")) === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch {}
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > FILESYSTEM_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`worktree isolation: timed out waiting for lock ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function withWorktreeLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(key) ?? Promise.resolve();
  let releaseLocal = (): void => {};
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => current);
  worktreeLocks.set(key, tail);
  await previous;
  let releaseFilesystem: (() => Promise<void>) | null = null;
  try {
    releaseFilesystem = await acquireFilesystemLock(key);
    return await action();
  } finally {
    await releaseFilesystem?.();
    releaseLocal();
    if (worktreeLocks.get(key) === tail) worktreeLocks.delete(key);
  }
}
