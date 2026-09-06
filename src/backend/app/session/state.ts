import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRemoteHome, remoteHome } from "@/backend/shared/paths.ts";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import type { SessionRecord } from "@/kernel/std/types/session.ts";

const FILE_MODE = 0o600;
const LEGACY_SESSION_STATE_VERSION = 2;
const LEGACY_SESSION_FILE = /^session-(.+)\.json$/;

/** Where the restored per-session activation value came from. */
export type RemoteStateSource = "records" | "legacy" | "default";

function autoEnablePath(): string {
  return join(remoteHome(), "state.json");
}

function legacySessionStatePath(sessionId: string): string {
  return join(remoteHome(), `session-${sessionId}.json`);
}

function readAutoEnableFlag(): boolean {
  const path = autoEnablePath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { autoEnable?: unknown };
    return parsed.autoEnable === true;
  } catch {
    return false;
  }
}

function writeAutoEnableFlag(autoEnable: boolean): void {
  ensureRemoteHome();
  writeFileSecure(autoEnablePath(), JSON.stringify({ autoEnable }, null, 2), FILE_MODE);
}

function readLegacySessionEnabled(sessionId: string): boolean | null {
  const path = legacySessionStatePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      enabled?: unknown;
    };
    if (parsed.version !== LEGACY_SESSION_STATE_VERSION) return null;
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

/**
 * Latest-wins per-session activation from the session's own transcript
 * metadata — the durable home of the flag.
 */
export function resolveRecordedRemoteEnabled(records: readonly SessionRecord[]): boolean | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type !== "session_meta") continue;
    if (typeof record.remoteEnabled === "boolean") return record.remoteEnabled;
  }
  return null;
}

export function removeLegacyRemoteSessionState(sessionId: string): void {
  try {
    rmSync(legacySessionStatePath(sessionId), { force: true });
  } catch {}
}

/**
 * Delete per-session activation files whose session transcript no longer
 * exists. Files for live transcripts stay until their session is resumed and
 * adopts the value into its own metadata; nothing writes new files, so the
 * remote home stops accumulating.
 */
export function sweepLegacyRemoteSessionState(liveSessionIds: ReadonlySet<string>): void {
  const home = remoteHome();
  if (!existsSync(home)) return;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = LEGACY_SESSION_FILE.exec(entry);
    const sessionId = match?.[1];
    if (!sessionId || liveSessionIds.has(sessionId)) continue;
    try {
      rmSync(join(home, entry), { force: true });
    } catch {}
  }
}

let sessionEnabled = false;

const listeners = new Set<() => void>();

export function subscribeRemoteState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Restore the session's activation: its own transcript metadata wins, a
 * pre-metadata activation file is adopted next, and only a session with
 * neither inherits the global auto-enable default. The caller persists
 * adopted/default values into the transcript; this module never writes
 * per-session files.
 */
export function initRemoteSession(
  sessionId: string,
  records: readonly SessionRecord[] = [],
): RemoteStateSource {
  const recorded = resolveRecordedRemoteEnabled(records);
  const legacy = recorded === null ? readLegacySessionEnabled(sessionId) : null;
  sessionEnabled = recorded ?? legacy ?? isAutoEnable();
  notify();
  return recorded !== null ? "records" : legacy !== null ? "legacy" : "default";
}

export function isRemoteEnabled(): boolean {
  return sessionEnabled;
}

export function setRemoteEnabled(enabled: boolean): void {
  sessionEnabled = enabled;
  notify();
}

export function isAutoEnable(): boolean {
  return readAutoEnableFlag();
}

export function setAutoEnable(autoEnable: boolean): void {
  writeAutoEnableFlag(autoEnable);
  notify();
}
