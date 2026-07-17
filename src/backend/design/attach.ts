import type { Device } from "@/backend/shared/device.ts";
import { b64uDecode, verifyDesignConfirmToken, wrapSessionKey } from "@/backend/shared/e2ee.ts";
import { shareSessionKey } from "../shared/api.ts";

export async function shareKeyWithWeb(args: {
  device: Device;
  sessionHash: string;
  sessionKey: Uint8Array;
  webDeviceId: string;
  webPubB64: string;
  confirmTokenB64: string;
}): Promise<void> {
  const peerPub = b64uDecode(args.webPubB64);
  const authentic = verifyDesignConfirmToken({
    myPriv: args.device.priv,
    theirPub: peerPub,
    sessionId: args.sessionHash,
    expected: b64uDecode(args.confirmTokenB64),
  });
  if (!authentic) {
    throw new Error("design confirm token mismatch — refusing K_proj wrap (possible broker MITM)");
  }
  const wrapped = wrapSessionKey({
    senderPriv: args.device.priv,
    peerPub,
    sessionId: args.sessionHash,
    senderDeviceId: args.device.id,
    peerDeviceId: args.webDeviceId,
    sessionKey: args.sessionKey,
  });
  await shareSessionKey({
    session_id: args.sessionHash,
    entries: [{ device_id: args.webDeviceId, sender_device_id: args.device.id, wrapped }],
  });
}
