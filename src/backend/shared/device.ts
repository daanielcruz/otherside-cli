import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, hostname, platform } from "node:os";
import { currentUserId } from "@/backend/shared/auth.ts";
import type { Bytes } from "@/backend/shared/e2ee.ts";
import { b64uDecode, b64uEncode, generateDeviceKeyPair } from "@/backend/shared/e2ee.ts";
import { devicePath, ensureRemoteHome } from "@/backend/shared/paths.ts";
import { writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";

const FILE_MODE = 0o600;
const LEGACY_USER_KEY = "__legacy__";

export interface Device {
  id: string;
  name: string;
  priv: Bytes;
  pub: Bytes;
  createdAt: string;
}

interface StoredDevice {
  id: string;
  name?: string;
  priv_b64: string;
  pub_b64: string;
  created_at: string;
}

interface DeviceStore {
  version: 2;
  devices: Record<string, StoredDevice>;
}

type RawStore =
  | { kind: "none" }
  | { kind: "legacy"; device: StoredDevice }
  | { kind: "v2"; store: DeviceStore };

function defaultName(): string {
  return hostname() || "cli";
}

export function deviceFingerprint(): string {
  const cpuModel = cpus()[0]?.model ?? "";
  const seed = [hostname(), platform(), arch(), cpuModel].join("::");
  return createHash("sha256").update(seed).digest("hex");
}

function toStored(device: Device): StoredDevice {
  return {
    id: device.id,
    name: device.name,
    priv_b64: b64uEncode(device.priv),
    pub_b64: b64uEncode(device.pub),
    created_at: device.createdAt,
  };
}

function fromStored(stored: StoredDevice): Device {
  return {
    id: stored.id,
    name: stored.name || defaultName(),
    priv: b64uDecode(stored.priv_b64),
    pub: b64uDecode(stored.pub_b64),
    createdAt: stored.created_at,
  };
}

function isStoredDevice(value: unknown): value is StoredDevice {
  const candidate = value as StoredDevice | null;
  return (
    typeof candidate?.id === "string" &&
    typeof candidate?.priv_b64 === "string" &&
    typeof candidate?.pub_b64 === "string"
  );
}

function isDeviceStore(value: unknown): value is DeviceStore {
  const candidate = value as DeviceStore | null;
  return candidate?.version === 2 && typeof candidate?.devices === "object";
}

function readRawStore(): RawStore {
  const path = devicePath();
  if (!existsSync(path)) return { kind: "none" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isDeviceStore(parsed)) return { kind: "v2", store: parsed };
    if (isStoredDevice(parsed)) return { kind: "legacy", device: parsed };
    return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

function persistStore(store: DeviceStore): void {
  ensureRemoteHome();
  writeFileSecure(devicePath(), JSON.stringify(store, null, 2), FILE_MODE);
}

function createDevice(): Device {
  const keyPair = generateDeviceKeyPair();
  return {
    id: crypto.randomUUID(),
    name: defaultName(),
    priv: keyPair.priv,
    pub: keyPair.pub,
    createdAt: new Date().toISOString(),
  };
}

export function loadDevice(): Device | null {
  const key = currentUserId() ?? LEGACY_USER_KEY;
  const raw = readRawStore();
  if (raw.kind === "legacy") return fromStored(raw.device);
  if (raw.kind === "v2") {
    const existing = raw.store.devices[key];
    return existing ? fromStored(existing) : null;
  }
  return null;
}

export function dropCurrentDevice(): void {
  const key = currentUserId() ?? LEGACY_USER_KEY;
  const raw = readRawStore();
  if (raw.kind === "legacy") {
    const store: DeviceStore = { version: 2, devices: {} };
    persistStore(store);
    return;
  }
  if (raw.kind !== "v2") return;
  if (!(key in raw.store.devices)) return;
  const devices = { ...raw.store.devices };
  delete devices[key];
  persistStore({ version: 2, devices });
}

export function rotateDeviceKeypair(): Device | null {
  const key = currentUserId() ?? LEGACY_USER_KEY;
  const raw = readRawStore();
  if (raw.kind === "legacy") {
    const keyPair = generateDeviceKeyPair();
    const rotated: StoredDevice = {
      ...raw.device,
      priv_b64: b64uEncode(keyPair.priv),
      pub_b64: b64uEncode(keyPair.pub),
    };
    persistStore({ version: 2, devices: { [key]: rotated } });
    return fromStored(rotated);
  }
  if (raw.kind !== "v2") return null;
  const existing = raw.store.devices[key];
  if (!existing) return null;
  const keyPair = generateDeviceKeyPair();
  const rotated: StoredDevice = {
    ...existing,
    priv_b64: b64uEncode(keyPair.priv),
    pub_b64: b64uEncode(keyPair.pub),
  };
  const devices = { ...raw.store.devices, [key]: rotated };
  persistStore({ version: 2, devices });
  return fromStored(rotated);
}

export function ensureDevice(): Device {
  const userId = currentUserId();
  const key = userId ?? LEGACY_USER_KEY;
  const raw = readRawStore();

  if (raw.kind === "legacy") {
    if (userId) persistStore({ version: 2, devices: { [userId]: raw.device } });
    return fromStored(raw.device);
  }

  const store: DeviceStore = raw.kind === "v2" ? raw.store : { version: 2, devices: {} };
  const existing = store.devices[key];
  if (existing) return fromStored(existing);

  if (userId) {
    const pending = store.devices[LEGACY_USER_KEY];
    if (pending) {
      const devices = { ...store.devices, [userId]: pending };
      delete devices[LEGACY_USER_KEY];
      persistStore({ version: 2, devices });
      return fromStored(pending);
    }
  }

  const device = createDevice();
  store.devices[key] = toStored(device);
  persistStore(store);
  return device;
}
