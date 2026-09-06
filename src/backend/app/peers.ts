import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { setRemoteEnabled } from "@/backend/app/session/state.ts";
import { registerEnvironment } from "@/backend/shared/api.ts";
import {
  currentUserId,
  decodeAuthScope,
  loadAuth,
  loadFreshAuth,
  revokeAndClearAuth,
} from "@/backend/shared/auth.ts";
import { cortexFetch } from "@/backend/shared/cortex.ts";
import {
  adoptDeviceId,
  type Device,
  deviceFingerprint,
  ensureDevice,
  rotateDeviceKeypair,
} from "@/backend/shared/device.ts";
import type { Bytes } from "@/backend/shared/e2ee.ts";
import { b64uDecode, b64uEncode } from "@/backend/shared/e2ee.ts";
import { ensurePeersDir, peerPath, peersDir } from "@/backend/shared/paths.ts";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
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
  const storedAuth = loadAuth();
  const hasDeviceCredential = !!storedAuth && decodeAuthScope(storedAuth.accessToken) === "device";
  const auth = await loadFreshAuth();
  try {
    if (auth) {
      const device = ensureDevice();
      await unpair({ cli_device_id: device.id, app_device_id: deviceId });
    }
  } catch {
    // Local unpair remains available while the backend is unreachable.
  }
  removeLocalPeerFile(deviceId);
  if (listPeers().length > 0) return;
  rotateDeviceKeypair();
  if (hasDeviceCredential) await revokeAndClearAuth();
}

// Losing every pairing disables remote and rotates the E2EE keypair. The device
// id stays stable because it names this machine's durable backend environment row.
export function retireRemotePairings(): void {
  rotateDeviceKeypair();
  setRemoteEnabled(false);
}

// Sign-out orders matter: backend unpair needs the live token, so pairings are
// released first, then device credentials self-revoke before local removal. The
// stable device id keeps naming this machine while its E2EE keypair rotates.
export async function signOutRemote(): Promise<void> {
  const device = ensureDevice();
  for (const peer of listPeers()) {
    try {
      await unpair({ cli_device_id: device.id, app_device_id: peer.deviceId });
    } catch {}
    removeLocalPeerFile(peer.deviceId);
  }
  retireRemotePairings();
  await revokeAndClearAuth();
}

export function touchPeer(deviceId: string): void {
  const peer = loadPeer(deviceId);
  if (!peer) return;
  savePeer({ ...peer, lastSeenAt: new Date().toISOString() });
}

/**
 * Register this machine's environment under its durable id and adopt the
 * backend's canonical id when they diverge (identity lost locally). Returns
 * the device whose id matches the backend row.
 */
export async function registerDeviceEnvironment(device: Device): Promise<Device> {
  const result = await registerEnvironment({
    id: device.id,
    device_label: device.name,
    fingerprint_hash: deviceFingerprint(),
    kind: "cli",
  });
  if (result.environment_id && result.environment_id !== device.id) {
    return adoptDeviceId(result.environment_id) ?? device;
  }
  return device;
}

export async function syncPeersWithBackend(): Promise<void> {
  const auth = await loadFreshAuth();
  if (!auth) return;

  let device = ensureDevice();
  try {
    device = await registerDeviceEnvironment(device);
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
