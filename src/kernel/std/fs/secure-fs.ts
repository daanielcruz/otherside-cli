import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isWindows } from "../proc/platform.ts";

const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_BACKOFF_MS = 25;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);

export function chmodIfPosix(path: string, mode: number): void {
  if (isWindows()) return;
  try {
    chmodSync(path, mode);
  } catch {}
}

export function mkdirSecure(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode: isWindows() ? undefined : mode });
}

export function writeFileSecure(path: string, data: string | Uint8Array, mode: number): void {
  writeFileSync(path, data, isWindows() ? undefined : { mode });
  chmodIfPosix(path, mode);
}

export function atomicWriteFileSync(path: string, data: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  if (mode !== undefined) writeFileSecure(tmp, data, mode);
  else writeFileSync(tmp, data);
  renameReplaceSync(tmp, path);
}

function isRetryableRenameError(error: unknown): boolean {
  if (!isWindows() || !(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && RETRYABLE_RENAME_CODES.has(code);
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameReplaceSync(source: string, dest: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(source, dest);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt > RENAME_RETRY_ATTEMPTS) throw error;
      if (attempt === RENAME_RETRY_ATTEMPTS) {
        try {
          unlinkSync(dest);
        } catch {}
      }
      sleepSyncMs(RENAME_RETRY_BACKOFF_MS);
    }
  }
}
