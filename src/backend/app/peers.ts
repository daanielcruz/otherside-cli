import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { setRemoteEnabled } from "@/backend/app/session/state.ts";
import { currentUserId, loadFreshAuth } from "@/backend/shared/auth.ts";
import { cortexFetch } from "@/backend/shared/cortex.ts";
import type { Bytes } from "@/backend/shared/e2ee.ts";
import { b64uDecode, b64uEncode } from "@/backend/shared/e2ee.ts";
import { ensurePeersDir, peerPath, peersDir } from "@/backend/shared/paths.ts";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import { registerEnvironment } from "../shared/api.ts";
import {
  deviceFingerprint,
  dropCurrentDevice,
  ensureDevice,
  rotateDeviceKeypair,
} from "../shared/device.ts";
import { unpair } from "./pairing-api.ts";

const FILE_MODE = 0o600;

export interface Peer {
  deviceId: string;
  userId: string;
  label: string;
  kind: "cli" | "app";
  pub: Bytes;
  verifiedAt: string;
  lastSeenAt?: string;
}

interface StoredPeer {
  deviceId: string;
  userId: string;
  label: string;
  kind: "cli" | "app";
  pub_b64: string;
  verifiedAt: string;
  lastSeenAt?: string;
}

function toStored(peer: Peer): StoredPeer {
  const stored: StoredPeer = {
    deviceId: peer.deviceId,
    userId: peer.userId,
    label: peer.label,
    kind: peer.kind,
    pub_b64: b64uEncode(peer.pub),
    verifiedAt: peer.verifiedAt,
  };
  if (peer.lastSeenAt) stored.lastSeenAt = peer.lastSeenAt;
  return stored;
}

function fromStored(stored: StoredPeer): Peer {
  const peer: Peer = {
    deviceId: stored.deviceId,
    userId: stored.userId,
    label: stored.label,
    kind: stored.kind,
    pub: b64uDecode(stored.pub_b64),
    verifiedAt: stored.verifiedAt,
  };
  if (stored.lastSeenAt) peer.lastSeenAt = stored.lastSeenAt;
  return peer;
}

export function savePeer(peer: Peer): void {
  ensurePeersDir();
  writeFileSecure(peerPath(peer.deviceId), JSON.stringify(toStored(peer), null, 2), FILE_MODE);
}

export function loadPeer(deviceId: string): Peer | null {
  const path = peerPath(deviceId);
  if (!existsSync(path)) return null;
  try {
    return fromStored(JSON.parse(readFileSync(path, "utf8")) as StoredPeer);
  } catch {
    return null;
  }
}

export function listPeers(): Peer[] {
  const dir = peersDir();
  if (!existsSync(dir)) return [];
  const userId = currentUserId();
  const out: Peer[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const peer = loadPeer(entry.slice(0, -".json".length));
    if (!peer) continue;
    if (userId && peer.userId !== userId) continue;
    out.push(peer);
  }
  return out;
}

export function removeLocalPeerFile(deviceId: string): void {
  const path = peerPath(deviceId);
  if (!existsSync(path)) return;
  try {
    rmSync(path);
  } catch {}
}

export async function removePeer(deviceId: string): Promise<void> {
  try {
    const auth = await loadFreshAuth();
    if (auth) {
      const device = ensureDevice();
      await unpair({ cli_device_id: device.id, app_device_id: deviceId });
    }
  } catch (err) {
    // If backend unpair fails (e.g. invalid token or network offline), we must
    // still allow the user to clear the local peer so they aren't permanently stuck.
  }
  removeLocalPeerFile(deviceId);
  if (listPeers().length === 0) rotateDeviceKeypair();
}

// Login owns the stored auth: unpairing (or resetting the device identity)
// drops the pairing, never the sign-in — the same account serves the design
// relay. Sign-out is the only path that clears auth.
export function resetRemoteIdentity(): void {
  dropCurrentDevice();
  setRemoteEnabled(false);
}

export function touchPeer(deviceId: string): void {
  const peer = loadPeer(deviceId);
  if (!peer) return;
  savePeer({ ...peer, lastSeenAt: new Date().toISOString() });
}

export async function syncPeersWithBackend(): Promise<void> {
  const auth = await loadFreshAuth();
  if (!auth) return;

  const device = ensureDevice();
  try {
    // Register with our own id: the backend resolves this environment by id at
    // confirm, and an id-less registration could mint a second row that later
    // collides on the fingerprint index.
    await registerEnvironment({
      id: device.id,
      device_label: device.name,
      fingerprint_hash: deviceFingerprint(),
      kind: "cli",
    });
  } catch {}

  const remotePeerIds = await fetchActivePeerIds(auth.accessToken, device.id);
  if (remotePeerIds === null) return;

  for (const lp of listPeers()) {
    if (!remotePeerIds.has(lp.deviceId)) removeLocalPeerFile(lp.deviceId);
  }
}

async function fetchActivePeerIds(
  accessToken: string,
  deviceId: string,
): Promise<Set<string> | null> {
  try {
    const rows = await cortexFetch<Array<{ device_a: string; device_b: string }>>("/v1/pairings", {
      method: "GET",
      token: accessToken,
    });
    return new Set(
      rows.map((p) => (p.device_a === deviceId ? p.device_b : p.device_a)).filter(Boolean),
    );
  } catch {
    return null;
  }
}
