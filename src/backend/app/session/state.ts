import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRemoteHome, remoteHome } from "@/backend/shared/paths.ts";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";

const FILE_MODE = 0o600;

function autoEnablePath(): string {
  return join(remoteHome(), "state.json");
}

function sessionEnabledPath(sessionId: string): string {
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

function readSessionEnabled(sessionId: string): boolean {
  const path = sessionEnabledPath(sessionId);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

function clearSessionEnabledFlag(sessionId: string): void {
  try {
    rmSync(sessionEnabledPath(sessionId));
  } catch {}
}

function writeSessionEnabledFlag(sessionId: string): void {
  ensureRemoteHome();
  writeFileSecure(
    sessionEnabledPath(sessionId),
    JSON.stringify({ enabled: true }, null, 2),
    FILE_MODE,
  );
}

let sessionEnabled = false;
let currentSessionId: string | undefined;

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

export function initRemoteSession(sessionId: string): void {
  currentSessionId = sessionId;
  sessionEnabled = readSessionEnabled(sessionId);
  notify();
}

export function isRemoteEnabled(): boolean {
  return sessionEnabled;
}

export function setRemoteEnabled(enabled: boolean): void {
  sessionEnabled = enabled;
  if (currentSessionId !== undefined) {
    enabled ? writeSessionEnabledFlag(currentSessionId) : clearSessionEnabledFlag(currentSessionId);
  }
  notify();
}

export function isAutoEnable(): boolean {
  return readAutoEnableFlag();
}

export function setAutoEnable(autoEnable: boolean): void {
  writeAutoEnableFlag(autoEnable);
  notify();
}
