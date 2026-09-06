import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { quotaCacheRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

/**
 * Cross-process quota cache: the in-process refresh gate only dedupes a single
 * session's own polling, but several concurrent CLI sessions each hold their
 * own gate and would each poll a provider's usage API on their own cadence.
 * Persisting the last observation per provider lets any process adopt a
 * sibling's fresh result instead of fetching again — N sessions no longer
 * N-times the request volume. The payload contains only quota windows, never
 * credential material.
 */

const QUOTA_CACHE_VERSION = 1;

export type SharedQuotaRecord = {
  version: number;
  lastSuccessAtEpochMs: number | null;
  lastErrorAtEpochMs: number | null;
  lastError: string | null;
  data: unknown;
};

export function readSharedQuotaRecord(provider: ProviderId): SharedQuotaRecord | null {
  const path = quotaCachePath(provider);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SharedQuotaRecord>;
    if (raw.version !== QUOTA_CACHE_VERSION) return null;
    return {
      version: QUOTA_CACHE_VERSION,
      lastSuccessAtEpochMs: numberOrNull(raw.lastSuccessAtEpochMs),
      lastErrorAtEpochMs: numberOrNull(raw.lastErrorAtEpochMs),
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      data: raw.data ?? null,
    };
  } catch {
    return null;
  }
}

export function writeSharedQuotaRecord(provider: ProviderId, record: SharedQuotaRecord): void {
  const path = quotaCachePath(provider);
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(path, () => {
      atomicWriteFileSync(path, serialize(record), 0o600);
    });
  } catch {}
}

/** A failed fetch stamps the shared error so peer processes back off too. */
export function writeSharedQuotaError(
  provider: ProviderId,
  lastErrorAtEpochMs: number,
  lastError: string,
): void {
  const path = quotaCachePath(provider);
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(path, () => {
      const existing = readSharedQuotaRecord(provider);
      atomicWriteFileSync(
        path,
        serialize({
          version: QUOTA_CACHE_VERSION,
          lastSuccessAtEpochMs: existing?.lastSuccessAtEpochMs ?? null,
          lastErrorAtEpochMs,
          lastError,
          data: existing?.data ?? null,
        }),
        0o600,
      );
    });
  } catch {}
}

export function deleteSharedQuotaRecord(provider: ProviderId): void {
  try {
    rmSync(quotaCachePath(provider), { force: true });
  } catch {}
}

function quotaCachePath(provider: ProviderId): string {
  return join(quotaCacheRoot(), `${encodeURIComponent(provider)}.json`);
}

function serialize(record: SharedQuotaRecord): string {
  return `${JSON.stringify(
    {
      version: QUOTA_CACHE_VERSION,
      lastSuccessAtEpochMs: record.lastSuccessAtEpochMs,
      lastErrorAtEpochMs: record.lastErrorAtEpochMs,
      lastError: record.lastError,
      data: record.data ?? null,
    },
    null,
    2,
  )}\n`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
