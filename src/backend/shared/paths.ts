import { join } from "node:path";

import { configRoot } from "@/kernel/std/fs/paths.ts";
import { mkdirSecure } from "@/kernel/std/fs/secure-fs.ts";

const DIR_MODE = 0o700;

export function remoteHome(): string {
  const override = process.env.OTHERSIDE_REMOTE_HOME;
  if (override) return override;
  return join(configRoot(), "remote");
}

export function devicePath(): string {
  return join(remoteHome(), "device.json");
}

export function authPath(): string {
  return join(remoteHome(), "auth.json");
}

export function peersDir(): string {
  return join(remoteHome(), "peers");
}

export function peerPath(deviceId: string): string {
  return join(peersDir(), `${deviceId}.json`);
}

export function pendingEventsPath(): string {
  return join(remoteHome(), "pending_events.jsonl");
}

export function ensureRemoteHome(): void {
  mkdirSecure(remoteHome(), DIR_MODE);
}

export function ensurePeersDir(): void {
  mkdirSecure(peersDir(), DIR_MODE);
}
