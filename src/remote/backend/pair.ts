import { cortexFetch } from "@/remote/_infra/cortex.ts";
import { renderQr } from "@/remote/_infra/qr.ts";
import {
  type BroadcastFrame,
  type RealtimeChannel,
  subscribeChannel,
} from "@/remote/_infra/realtime.ts";
import {
  b64uDecode,
  b64uEncode,
  generatePairNonce,
  hexToBytes,
  unwrapSessionBundle,
  verifyPairConfirmToken,
} from "@/remote/crypto/e2ee.ts";
import { type Device, deviceFingerprint, migrateDevice } from "@/remote/devices/device.ts";
import { listPeers, removeLocalPeerFile, savePeer } from "@/remote/devices/peers.ts";
import { registerEnvironment } from "./api.ts";
import { currentUserId, decodeUserId, type RemoteAuth, saveAuth } from "./auth.ts";
import { encodeQrV2 } from "./qr-payload.ts";

const PAIR_TIMEOUT_MS = 180_000;
const DEC = new TextDecoder();

interface ConfirmBroadcast {
  app_device_id: string;
  app_pub: string;
  confirm_token: string;
}

interface SessionBundleBroadcast {
  app_device_id: string;
  kind: string;
  wrapped: { v: 1; n: string; ct: string };
}

export interface PairHandle {
  qr: string;
  nonceB64: string;
  payload: string;
  awaiting: Promise<PairResult>;
  // Tears down the realtime subscription and timeout for an abandoned code, so
  // regenerating (or closing the panel) never leaves the channel open until its
  // own timeout fires.
  cancel: () => void;
}

export interface PairResult {
  peerDeviceId: string;
  userId: string;
  environmentId: string;
}

function decodeConfirm(payload: Record<string, unknown>): ConfirmBroadcast | null {
  const { app_device_id, app_pub, confirm_token } = payload;
  if (typeof app_device_id !== "string") return null;
  if (typeof app_pub !== "string") return null;
  if (typeof confirm_token !== "string") return null;
  return { app_device_id, app_pub, confirm_token };
}

function decodeBundle(payload: Record<string, unknown>): SessionBundleBroadcast | null {
  const { app_device_id, kind, wrapped } = payload;
  if (typeof app_device_id !== "string" || typeof kind !== "string") return null;
  if (typeof wrapped !== "object" || wrapped === null) return null;
  const envelope = wrapped as { v?: unknown; n?: unknown; ct?: unknown };
  if (envelope.v !== 1 || typeof envelope.n !== "string" || typeof envelope.ct !== "string") {
    return null;
  }
  return { app_device_id, kind, wrapped: { v: 1, n: envelope.n, ct: envelope.ct } };
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

function unwrapAuth(args: {
  device: Device;
  nonce: Uint8Array;
  appPub: Uint8Array;
  bundle: SessionBundleBroadcast;
}): RemoteAuth {
  const plaintext = unwrapSessionBundle({
    cliPriv: args.device.priv,
    appPub: args.appPub,
    nonce: args.nonce,
    cliDeviceId: args.device.id,
    appDeviceId: args.bundle.app_device_id,
    wrapped: args.bundle.wrapped,
  });
  const parsed = JSON.parse(DEC.decode(plaintext)) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_at,
  };
}

interface PairState {
  appPub?: Uint8Array;
  appDeviceId?: string;
}

function settlePair(args: {
  device: Device;
  nonce: Uint8Array;
  channel: RealtimeChannel;
  resolve: (r: PairResult) => void;
  reject: (e: Error) => void;
}): (frame: BroadcastFrame) => void {
  const state: PairState = {};

  const finish = async (
    peer: { appPub: Uint8Array; appDeviceId: string },
    bundle: SessionBundleBroadcast,
  ): Promise<void> => {
    const auth = unwrapAuth({
      device: args.device,
      nonce: args.nonce,
      appPub: peer.appPub,
      bundle,
    });
    const prevUserId = currentUserId();
    saveAuth(auth);
    const userId = decodeUserId(auth.accessToken);
    migrateDevice(prevUserId, userId);

    let label = "paired app";
    try {
      const rows = await cortexFetch<Array<{ id: string; device_label: string }>>(
        "/v1/environments",
        { method: "GET", token: auth.accessToken },
      );
      const match = rows.find((r) => r.id === peer.appDeviceId);
      if (match?.device_label) label = match.device_label;
    } catch {}

    savePeer({
      deviceId: peer.appDeviceId,
      userId,
      label,
      kind: "app",
      pub: peer.appPub,
      verifiedAt: new Date().toISOString(),
    });

    for (const old of listPeers()) {
      if (old.deviceId !== peer.appDeviceId) removeLocalPeerFile(old.deviceId);
    }

    try {
      await registerEnvironment({
        device_label: args.device.name,
        fingerprint_hash: deviceFingerprint(),
        kind: "cli",
      });
    } catch {}
    args.channel.close();
    args.resolve({
      peerDeviceId: peer.appDeviceId,
      userId,
      environmentId: args.device.id,
    });
  };

  const onConfirm = (frame: BroadcastFrame): void => {
    if (state.appDeviceId) return;
    const confirm = decodeConfirm(frame.payload);
    if (!confirm) return;
    const appPub = verifyConfirm(args.device, args.nonce, confirm);
    state.appPub = appPub;
    state.appDeviceId = confirm.app_device_id;
  };

  const onBundle = (frame: BroadcastFrame): void => {
    const { appPub, appDeviceId } = state;
    if (!appPub || !appDeviceId) throw new Error("session bundle arrived before confirm");
    const bundle = decodeBundle(frame.payload);
    if (!bundle || bundle.kind !== "session-bundle") return;
    void finish({ appPub, appDeviceId }, bundle).catch((err) => {
      args.channel.close();
      args.reject(err instanceof Error ? err : new Error(String(err)));
    });
  };

  return (frame) => {
    try {
      if (frame.event === "confirm") onConfirm(frame);
      else if (frame.event === "session-bundle") onBundle(frame);
    } catch (err) {
      args.channel.close();
      args.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

export async function beginPair(device: Device): Promise<PairHandle> {
  const nonce = generatePairNonce();
  const nonceB64 = b64uEncode(nonce);
  const qrData = encodeQrV2({
    deviceId: device.id,
    pub: device.pub,
    nonce,
    fingerprintHex: deviceFingerprint(),
  });
  const qr = renderQr(qrData);

  let onResolve!: (r: PairResult) => void;
  let onReject!: (e: Error) => void;
  const awaiting = new Promise<PairResult>((resolve, reject) => {
    onResolve = resolve;
    onReject = reject;
  });

  const channel = await subscribeChannel({
    topic: `pair:${nonceB64}`,
    onError: (err) => onReject(err),
  });

  channel.onBroadcast = settlePair({
    device,
    nonce,
    channel,
    resolve: onResolve,
    reject: onReject,
  });

  const timeout = setTimeout(() => {
    channel.close();
    onReject(new Error("pairing timed out — no response from app"));
  }, PAIR_TIMEOUT_MS);
  awaiting.finally(() => clearTimeout(timeout)).catch(() => {});

  const cancel = () => {
    clearTimeout(timeout);
    channel.close();
    onReject(new Error("pairing cancelled"));
  };

  return { qr, nonceB64, payload: qrData, awaiting, cancel };
}
