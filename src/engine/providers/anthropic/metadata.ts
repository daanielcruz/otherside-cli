import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

const DEVICE_ID_HEX_LENGTH = 64;

let cachedDeviceId: string | null = null;

function deviceId(): string {
  if (cachedDeviceId !== null) return cachedDeviceId;
  const path = join(configRoot(), "device-id");
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (existing.length === DEVICE_ID_HEX_LENGTH) {
        cachedDeviceId = existing;
        return existing;
      }
    } catch {}
  }
  const fresh = createHash("sha256").update(randomUUID()).digest("hex");
  try {
    writeFileSync(path, fresh, { mode: 0o600 });
  } catch {}
  cachedDeviceId = fresh;
  return fresh;
}

export function anthropicUserIdMetadata(sessionId: string): string {
  // Fresh per call: a credential switch (possibly from another client
  // mid-turn) must surface the new account on the very next request.
  return JSON.stringify({
    device_id: deviceId(),
    account_uuid: accountFingerprint("anthropic"),
    session_id: sessionId,
  });
}
