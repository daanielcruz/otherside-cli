import { listPeers, removeLocalPeerFile, savePeer } from "@/backend/app/peers.ts";
import { renderQr } from "@/backend/app/qr.ts";
import { cortexFetch } from "@/backend/shared/cortex.ts";
import { type Device, deviceFingerprint } from "@/backend/shared/device.ts";
import {
  b64uDecode,
  b64uEncode,
  generatePairNonce,
  hexToBytes,
  verifyPairConfirmToken,
} from "@/backend/shared/e2ee.ts";
import {
  type BroadcastFrame,
  type RealtimeChannel,
  subscribeChannel,
} from "@/backend/shared/realtime.ts";
import { registerEnvironment } from "../shared/api.ts";
import { currentUserId, loadFreshAuth } from "../shared/auth.ts";
import { encodeQrV2 } from "./qr-payload.ts";

const PAIR_TIMEOUT_MS = 180_000;

interface ConfirmBroadcast {
  app_device_id: string;
  app_pub: string;
  confirm_token: string;
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

export function settlePair(args: {
  device: Device;
  nonce: Uint8Array;
  channel: RealtimeChannel;
  resolve: (r: PairResult) => void;
  reject: (e: Error) => void;
}): (frame: BroadcastFrame) => void {
  // Pairing settles at the verified confirm broadcast: the CLI is already
  // signed in, so the pair carries key exchange and the device link — never
  // auth material.
  const finish = async (peer: { appPub: Uint8Array; appDeviceId: string }): Promise<void> => {
    const userId = currentUserId();
    if (!userId) throw new Error("not signed in — sign in before pairing");
    const auth = await loadFreshAuth();

    let label = "paired app";
    if (auth) {
      try {
        const rows = await cortexFetch<Array<{ id: string; device_label: string }>>(
          "/v1/environments",
          { method: "GET", token: auth.accessToken },
        );
        const match = rows.find((r) => r.id === peer.appDeviceId);
        if (match?.device_label) label = match.device_label;
      } catch {}
    }

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

    args.channel.close();
    args.resolve({
      peerDeviceId: peer.appDeviceId,
      userId,
      environmentId: args.device.id,
    });
  };

  let settling = false;
  return (frame) => {
    if (frame.event !== "confirm" || settling) return;
    try {
      const confirm = decodeConfirm(frame.payload);
      if (!confirm) return;
      settling = true;
      const appPub = verifyConfirm(args.device, args.nonce, confirm);
      void finish({ appPub, appDeviceId: confirm.app_device_id }).catch((err) => {
        args.channel.close();
        args.reject(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      args.channel.close();
      args.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

export async function beginPair(device: Device): Promise<PairHandle> {
  const auth = await loadFreshAuth();
  if (!auth) throw new Error("not signed in — sign in before pairing");

  // The backend resolves the CLI at confirm by this environment id, so the
  // registration must land (with our own id) before the app can scan.
  await registerEnvironment({
    id: device.id,
    device_label: device.name,
    fingerprint_hash: deviceFingerprint(),
    kind: "cli",
  });

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
