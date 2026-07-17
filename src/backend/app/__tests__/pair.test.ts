import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPair, settlePair } from "@/backend/app/pair.ts";
import { loadPeer } from "@/backend/app/peers.ts";
import { saveAuth } from "@/backend/shared/auth.ts";
import { deviceFingerprint, ensureDevice } from "@/backend/shared/device.ts";
import {
  b64uEncode,
  generateDeviceKeyPair,
  generatePairNonce,
  hexToBytes,
  pairConfirmToken,
} from "@/backend/shared/e2ee.ts";
import type { RealtimeChannel } from "@/backend/shared/realtime.ts";

const APP_DEVICE_ID = "7f3a2b1c-0d4e-4f5a-8b6c-9d0e1f2a3b4c";

function fakeAccessToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${claims}.sig`;
}

function signIn(userId: string): void {
  saveAuth({
    accessToken: fakeAccessToken(userId),
    refreshToken: "refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe("pair flow", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pair-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = home;
    // Localhost is on the override allowlist; nothing listens there, so any
    // network call fails fast instead of leaving the test machine.
    process.env.OTHERSIDE_CORTEX_URL = "http://localhost:1";
  });

  afterEach(() => {
    delete process.env.OTHERSIDE_CONFIG_DIR;
    delete process.env.OTHERSIDE_CORTEX_URL;
    rmSync(home, { recursive: true, force: true });
  });

  test("beginPair rejects when signed out", async () => {
    const device = ensureDevice();
    await expect(beginPair(device)).rejects.toThrow("not signed in");
  });

  test("settle completes on the verified confirm broadcast alone", async () => {
    const userId = "11111111-2222-4333-8444-555555555555";
    signIn(userId);
    const device = ensureDevice();
    const nonce = generatePairNonce();
    const appKeys = generateDeviceKeyPair();
    const confirmToken = pairConfirmToken({
      myPriv: appKeys.priv,
      theirPub: device.pub,
      nonce,
      cliFingerprint: hexToBytes(deviceFingerprint()),
    });

    let closed = false;
    const channel = { close: () => (closed = true) } as unknown as RealtimeChannel;
    const result = await new Promise((resolve, reject) => {
      const onFrame = settlePair({ device, nonce, channel, resolve, reject });
      onFrame({
        event: "confirm",
        payload: {
          app_device_id: APP_DEVICE_ID,
          app_pub: b64uEncode(appKeys.pub),
          confirm_token: b64uEncode(confirmToken),
        },
      });
    });

    expect(result).toEqual({
      peerDeviceId: APP_DEVICE_ID,
      userId,
      environmentId: device.id,
    });
    expect(closed).toBe(true);
    const peer = loadPeer(APP_DEVICE_ID);
    expect(peer?.userId).toBe(userId);
    expect(peer?.kind).toBe("app");
  });

  test("settle rejects a forged confirm token", async () => {
    signIn("11111111-2222-4333-8444-555555555555");
    const device = ensureDevice();
    const nonce = generatePairNonce();
    const appKeys = generateDeviceKeyPair();

    let closed = false;
    const channel = { close: () => (closed = true) } as unknown as RealtimeChannel;
    const settled = new Promise((resolve, reject) => {
      const onFrame = settlePair({ device, nonce, channel, resolve, reject });
      onFrame({
        event: "confirm",
        payload: {
          app_device_id: APP_DEVICE_ID,
          app_pub: b64uEncode(appKeys.pub),
          confirm_token: b64uEncode(new Uint8Array(32)),
        },
      });
    });

    await expect(settled).rejects.toThrow("confirm token mismatch");
    expect(closed).toBe(true);
  });
});
