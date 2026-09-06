import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginPair,
  type PairingCredential,
  pollPairingToken,
  settlePair,
} from "@/backend/app/pair.ts";
import { loadPeer } from "@/backend/app/peers.ts";
import { loadAuth } from "@/backend/shared/auth.ts";
import { CortexApiError, type cortexFetch } from "@/backend/shared/cortex.ts";
import { deviceFingerprint, ensureDevice, loadDevice } from "@/backend/shared/device.ts";
import {
  b64uDecode,
  b64uEncode,
  generateDeviceKeyPair,
  generatePairNonce,
  hexToBytes,
  pairConfirmToken,
} from "@/backend/shared/e2ee.ts";
import type {
  RealtimeChannel,
  SubscribeOptions,
  subscribeChannel,
} from "@/backend/shared/realtime.ts";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const APP_DEVICE_ID = "7f3a2b1c-0d4e-4f5a-8b6c-9d0e1f2a3b4c";
const CLI_ENVIRONMENT_ID = "6e2a1b0c-9d8e-4765-8a4b-3c2d1e0f9a8b";
const USER_CODE = "ABCD-2345";

function accessToken(sub: string, scope = "device"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub, scp: scope })).toString("base64url");
  return `${header}.${claims}.signature`;
}

function credential(): PairingCredential {
  return {
    access_token: accessToken(USER_ID),
    refresh_token: "refresh-device-placeholder",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    auth_session_id: "55555555-6666-4777-8888-999999999999",
    environment_id: CLI_ENVIRONMENT_ID,
  };
}

function fakeChannel(): RealtimeChannel {
  return {
    send() {},
    onBroadcast() {},
    close() {},
  };
}

function pendingError(): CortexApiError {
  return new CortexApiError(
    "authorization_pending",
    "authorization_pending",
    "request-pending",
    428,
  );
}

describe("device-approved pair flow", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pair-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = home;
  });

  afterEach(() => {
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  test("pairs while signed out and stores the device credential", async () => {
    const device = ensureDevice();
    const appKeys = generateDeviceKeyPair();
    let pairTopic = "";
    const channel = fakeChannel();
    const requests: Array<{ path: string; body: unknown }> = [];
    const request = (async <T>(path: string, options?: { body?: unknown }): Promise<T> => {
      requests.push({ path, body: options?.body });
      if (path === "/v1/auth/device/code") {
        return {
          device_code: "device-code-placeholder",
          user_code: USER_CODE,
          expires_in: 900,
          interval: 5,
        } as T;
      }
      if (path === "/v1/pairings/token") return credential() as T;
      if (path === "/v1/environments") {
        return [{ id: APP_DEVICE_ID, device_label: "Test companion" }] as T;
      }
      throw new Error(`unexpected path ${path}`);
    }) as typeof cortexFetch;
    const subscribe = (async (options: SubscribeOptions) => {
      pairTopic = options.topic;
      return channel;
    }) as typeof subscribeChannel;

    const handle = await beginPair(device, { request, subscribe });
    expect(pairTopic.startsWith("pair:")).toBe(true);
    const nonce = b64uDecode(pairTopic.slice("pair:".length));
    const confirmToken = pairConfirmToken({
      myPriv: appKeys.priv,
      theirPub: device.pub,
      nonce,
      cliFingerprint: hexToBytes(deviceFingerprint()),
    });
    channel.onBroadcast({
      event: "confirm",
      payload: {
        app_device_id: APP_DEVICE_ID,
        app_pub: b64uEncode(appKeys.pub),
        confirm_token: b64uEncode(confirmToken),
      },
    });

    await expect(handle.awaiting).resolves.toEqual({
      peerDeviceId: APP_DEVICE_ID,
      userId: USER_ID,
      environmentId: CLI_ENVIRONMENT_ID,
    });
    expect(handle.payload.startsWith("OS3:")).toBe(true);
    expect(handle.userCode).toBe(USER_CODE);
    expect(requests.slice(0, 2)).toEqual([
      { path: "/v1/auth/device/code", body: { purpose: "pairing" } },
      { path: "/v1/pairings/token", body: { device_code: "device-code-placeholder" } },
    ]);
    expect(loadAuth()).toMatchObject({
      accessToken: credential().access_token,
      refreshToken: "refresh-device-placeholder",
    });
    expect(loadDevice()?.id).toBe(CLI_ENVIRONMENT_ID);
    expect(loadPeer(APP_DEVICE_ID)?.label).toBe("Test companion");
  });

  test("backs off while authorization is pending", async () => {
    let requests = 0;
    const waits: number[] = [];
    const request = (async <T>(): Promise<T> => {
      requests += 1;
      if (requests < 3) throw pendingError();
      return credential() as T;
    }) as typeof cortexFetch;

    const result = await pollPairingToken({
      deviceCode: "device-code-placeholder",
      expiresAt: 60_000,
      intervalMs: 1_000,
      signal: new AbortController().signal,
      now: () => 0,
      request,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result).toEqual(credential());
    expect(waits).toEqual([1_000, 1_500]);
  });

  test("maps an expired grant to a clear message", async () => {
    const request = (async () => {
      throw new CortexApiError("not_found", "expired_token", "request-expired", 404);
    }) as typeof cortexFetch;

    await expect(
      pollPairingToken({
        deviceCode: "device-code-placeholder",
        expiresAt: 60_000,
        intervalMs: 1_000,
        signal: new AbortController().signal,
        now: () => 0,
        request,
      }),
    ).rejects.toThrow("pairing code expired");
  });

  test("maps a consumed grant to a clear message", async () => {
    const request = (async () => {
      throw new CortexApiError("conflict", "already_consumed", "request-consumed", 409);
    }) as typeof cortexFetch;

    await expect(
      pollPairingToken({
        deviceCode: "device-code-placeholder",
        expiresAt: 60_000,
        intervalMs: 1_000,
        signal: new AbortController().signal,
        now: () => 0,
        request,
      }),
    ).rejects.toThrow("pairing code was already used");
  });

  test("settle resolves only after verifying the confirm token", async () => {
    const device = ensureDevice();
    const nonce = generatePairNonce();
    const appKeys = generateDeviceKeyPair();
    const confirmToken = pairConfirmToken({
      myPriv: appKeys.priv,
      theirPub: device.pub,
      nonce,
      cliFingerprint: hexToBytes(deviceFingerprint()),
    });

    const result = await new Promise((resolve, reject) => {
      const onFrame = settlePair({ device, nonce, resolve, reject });
      onFrame({
        event: "confirm",
        payload: {
          app_device_id: APP_DEVICE_ID,
          app_pub: b64uEncode(appKeys.pub),
          confirm_token: b64uEncode(confirmToken),
        },
      });
    });

    expect(result).toEqual({ appDeviceId: APP_DEVICE_ID, appPub: appKeys.pub });
  });

  test("settle rejects a forged confirm token", async () => {
    const device = ensureDevice();
    const nonce = generatePairNonce();
    const appKeys = generateDeviceKeyPair();
    const settled = new Promise((resolve, reject) => {
      const onFrame = settlePair({ device, nonce, resolve, reject });
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
  });
});
