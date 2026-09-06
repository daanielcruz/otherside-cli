import { listPeers, removeLocalPeerFile, savePeer } from "@/backend/app/peers.ts";
import { renderQr } from "@/backend/app/qr.ts";
import {
  currentUserId,
  decodeTokenResponse,
  decodeUserId,
  saveAuth,
  type TokenResponse,
} from "@/backend/shared/auth.ts";
import { CortexApiError, cortexFetch } from "@/backend/shared/cortex.ts";
import {
  adoptDeviceId,
  type Device,
  deviceFingerprint,
  ensureDevice,
} from "@/backend/shared/device.ts";
import {
  b64uDecode,
  b64uEncode,
  generatePairNonce,
  hexToBytes,
  verifyPairConfirmToken,
} from "@/backend/shared/e2ee.ts";
import { type BroadcastFrame, subscribeChannel } from "@/backend/shared/realtime.ts";
import { encodeQrV3 } from "./qr-payload.ts";

const DEFAULT_PAIR_TTL_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_MS = 30_000;
const POLL_BACKOFF_MULTIPLIER = 1.5;

interface PairingCodeResponse {
  device_code: string;
  user_code: string;
  expires_in?: number;
  interval?: number;
}

export interface PairingCredential extends TokenResponse {
  auth_session_id: string;
  environment_id: string;
}

interface ConfirmBroadcast {
  app_device_id: string;
  app_pub: string;
  confirm_token: string;
}

export interface VerifiedPairConfirm {
  appDeviceId: string;
  appPub: Uint8Array;
}

export interface PairHandle {
  qr: string;
  nonceB64: string;
  payload: string;
  userCode: string;
  expiresInSeconds: number;
  awaiting: Promise<PairResult>;
  cancel: () => void;
}

export interface PairResult {
  peerDeviceId: string;
  userId: string;
  environmentId: string;
}

interface PairDependencies {
  now: () => number;
  request: typeof cortexFetch;
  subscribe: typeof subscribeChannel;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: PairDependencies = {
  now: Date.now,
  request: cortexFetch,
  subscribe: subscribeChannel,
  wait: waitForRetry,
};

export async function beginPair(
  device: Device,
  dependencyOverrides: Partial<PairDependencies> = {},
): Promise<PairHandle> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const code = await requestPairingCode(dependencies.request);
  const expiresInSeconds = Math.max(1, code.expires_in ?? DEFAULT_PAIR_TTL_SECONDS);
  const expiresAt = dependencies.now() + expiresInSeconds * 1000;
  const nonce = generatePairNonce();
  const nonceB64 = b64uEncode(nonce);
  const qrData = encodeQrV3({
    deviceId: device.id,
    pub: device.pub,
    nonce,
    fingerprintHex: deviceFingerprint(),
    userCode: code.user_code,
  });

  let resolveConfirm!: (confirm: VerifiedPairConfirm) => void;
  let rejectConfirm!: (error: Error) => void;
  const confirmed = new Promise<VerifiedPairConfirm>((resolve, reject) => {
    resolveConfirm = resolve;
    rejectConfirm = reject;
  });
  const channel = await dependencies.subscribe({
    topic: `pair:${nonceB64}`,
    onError: rejectConfirm,
  });
  channel.onBroadcast = settlePair({
    device,
    nonce,
    resolve: resolveConfirm,
    reject: rejectConfirm,
  });

  let channelClosed = false;
  const closeChannel = () => {
    if (channelClosed) return;
    channelClosed = true;
    channel.close();
  };
  const abort = new AbortController();
  const expiredError = pairingExpiredError();
  const timeout = setTimeout(() => {
    abort.abort(expiredError);
    rejectConfirm(expiredError);
  }, expiresInSeconds * 1000);
  const credential = pollPairingToken({
    deviceCode: code.device_code,
    expiresAt,
    intervalMs: Math.max(1, code.interval ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    signal: abort.signal,
    now: dependencies.now,
    request: dependencies.request,
    wait: dependencies.wait,
  });
  const awaiting = Promise.all([confirmed, credential]).then(([confirm, pairedCredential]) =>
    persistPair({ confirm, credential: pairedCredential, request: dependencies.request }),
  );
  awaiting
    .finally(() => {
      clearTimeout(timeout);
      closeChannel();
      abort.abort();
    })
    .catch(() => {});

  const cancel = () => {
    const error = new Error("pairing cancelled");
    clearTimeout(timeout);
    closeChannel();
    abort.abort(error);
    rejectConfirm(error);
  };

  return {
    qr: renderQr(qrData),
    nonceB64,
    payload: qrData,
    userCode: code.user_code,
    expiresInSeconds,
    awaiting,
    cancel,
  };
}

async function requestPairingCode(request: typeof cortexFetch): Promise<PairingCodeResponse> {
  return request<PairingCodeResponse>("/v1/auth/device/code", {
    method: "POST",
    body: { purpose: "pairing" },
  });
}

export async function pollPairingToken(args: {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  signal: AbortSignal;
  now?: () => number;
  request?: typeof cortexFetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<PairingCredential> {
  const now = args.now ?? Date.now;
  const request = args.request ?? cortexFetch;
  const wait = args.wait ?? waitForRetry;
  let intervalMs = args.intervalMs;

  for (;;) {
    if (args.signal.aborted) throw abortError(args.signal);
    if (now() >= args.expiresAt) throw pairingExpiredError();
    try {
      return await request<PairingCredential>("/v1/pairings/token", {
        method: "POST",
        body: { device_code: args.deviceCode },
        signal: args.signal,
      });
    } catch (error) {
      if (args.signal.aborted) throw abortError(args.signal);
      if (isAuthorizationPending(error)) {
        const remainingMs = args.expiresAt - now();
        if (remainingMs <= 0) throw pairingExpiredError();
        await wait(Math.min(intervalMs, remainingMs), args.signal);
        intervalMs = Math.min(
          MAX_POLL_INTERVAL_MS,
          Math.ceil(intervalMs * POLL_BACKOFF_MULTIPLIER),
        );
        continue;
      }
      throw pairingPollError(error);
    }
  }
}

export function settlePair(args: {
  device: Device;
  nonce: Uint8Array;
  resolve: (confirm: VerifiedPairConfirm) => void;
  reject: (error: Error) => void;
}): (frame: BroadcastFrame) => void {
  let settling = false;
  return (frame) => {
    if (frame.event !== "confirm" || settling) return;
    try {
      const confirm = decodeConfirm(frame.payload);
      if (!confirm) return;
      settling = true;
      args.resolve({
        appDeviceId: confirm.app_device_id,
        appPub: verifyConfirm(args.device, args.nonce, confirm),
      });
    } catch (error) {
      args.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

async function persistPair(args: {
  confirm: VerifiedPairConfirm;
  credential: PairingCredential;
  request: typeof cortexFetch;
}): Promise<PairResult> {
  const userId = decodeUserId(args.credential.access_token);
  if (!userId) throw new Error("pairing credential did not identify an account");

  const auth = decodeTokenResponse(args.credential);
  saveAuth(auth);
  let pairedDevice = ensureDevice();
  if (args.credential.environment_id !== pairedDevice.id) {
    pairedDevice = adoptDeviceId(args.credential.environment_id) ?? pairedDevice;
  }

  const label = await loadPeerLabel(args.confirm.appDeviceId, auth.accessToken, args.request);
  savePeer({
    deviceId: args.confirm.appDeviceId,
    userId,
    label,
    kind: "app",
    pub: args.confirm.appPub,
    verifiedAt: new Date().toISOString(),
  });

  for (const old of listPeers()) {
    if (old.deviceId !== args.confirm.appDeviceId) removeLocalPeerFile(old.deviceId);
  }

  return {
    peerDeviceId: args.confirm.appDeviceId,
    userId: currentUserId() ?? userId,
    environmentId: pairedDevice.id,
  };
}

async function loadPeerLabel(
  appDeviceId: string,
  accessToken: string,
  request: typeof cortexFetch,
): Promise<string> {
  try {
    const rows = await request<Array<{ id: string; device_label: string }>>("/v1/environments", {
      method: "GET",
      token: accessToken,
    });
    return rows.find((row) => row.id === appDeviceId)?.device_label || "paired app";
  } catch {
    return "paired app";
  }
}

function decodeConfirm(payload: Record<string, unknown>): ConfirmBroadcast | null {
  const { app_device_id, app_pub, confirm_token } = payload;
  if (typeof app_device_id !== "string") return null;
  if (typeof app_pub !== "string") return null;
  if (typeof confirm_token !== "string") return null;
  return { app_device_id, app_pub, confirm_token };
}

function verifyConfirm(device: Device, nonce: Uint8Array, confirm: ConfirmBroadcast): Uint8Array {
  const appPub = b64uDecode(confirm.app_pub);
  const expected = b64uDecode(confirm.confirm_token);
  const ok = verifyPairConfirmToken({
    myPriv: device.priv,
    theirPub: appPub,
    nonce,
    cliFingerprint: hexToBytes(deviceFingerprint()),
    expected,
  });
  if (!ok) throw new Error("pair confirm token mismatch — aborting (possible MITM)");
  return appPub;
}

function isAuthorizationPending(error: unknown): boolean {
  return (
    error instanceof CortexApiError &&
    error.httpStatus === 428 &&
    error.code === "authorization_pending"
  );
}

function pairingPollError(error: unknown): Error {
  if (error instanceof CortexApiError && error.code === "not_found") {
    return pairingExpiredError();
  }
  if (error instanceof CortexApiError && error.code === "conflict") {
    return new Error("pairing code was already used — generate a new code");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function pairingExpiredError(): Error {
  return new Error("pairing code expired — generate a new code");
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("pairing cancelled");
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
