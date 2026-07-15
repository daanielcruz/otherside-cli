import type { UsageSnapshot } from "@/kernel/storage/provider-usage.ts";
import type { BroadcastFrame } from "@/remote/_infra/realtime.ts";
import { b64uEncode, wrapEnvBroadcast } from "@/remote/crypto/e2ee.ts";
import type { AvailableModelsProviders } from "./snapshot.ts";

const ENC = new TextEncoder();

export type EnvBroadcastEntries = {
  sender_device_id: string;
  salt: string;
  entries: Array<{ device_id: string; n: string; ct: string }>;
};

export interface EnvBroadcastDeps {
  peers: Array<{ deviceId: string; pub: Uint8Array }>;
  senderPriv: Uint8Array;
  senderDeviceId: string;
  salt: Uint8Array;
}

// Every env-channel broadcast shares the same encrypted envelope: the
// plaintext wrapped once per peer, addressed by device id, under one salt.
export function buildEncryptedEnvBroadcast(
  event: string,
  plaintext: Uint8Array,
  deps: EnvBroadcastDeps,
): BroadcastFrame {
  const entries = deps.peers.map((peer) => {
    const wrapped = wrapEnvBroadcast({
      senderPriv: deps.senderPriv,
      recipientPub: peer.pub,
      salt: deps.salt,
      senderDeviceId: deps.senderDeviceId,
      recipientDeviceId: peer.deviceId,
      plaintext,
    });
    return { device_id: peer.deviceId, n: wrapped.n, ct: wrapped.ct };
  });
  return {
    event,
    payload: { sender_device_id: deps.senderDeviceId, salt: b64uEncode(deps.salt), entries },
  };
}

export function buildAvailableModelsBroadcast(
  deps: EnvBroadcastDeps & { providers: AvailableModelsProviders },
): BroadcastFrame {
  const plaintext = ENC.encode(JSON.stringify({ providers: deps.providers }));
  return buildEncryptedEnvBroadcast("available_models", plaintext, deps);
}

export function buildProviderQuotaBroadcast(
  deps: EnvBroadcastDeps & { snapshot: UsageSnapshot; sessionId: string },
): BroadcastFrame {
  // session_id disambiguates concurrent CLI sessions on one device — the env
  // channel is device-scoped, so a device-keyed snapshot would flip between
  // sessions on every poll.
  const plaintext = ENC.encode(JSON.stringify({ ...deps.snapshot, session_id: deps.sessionId }));
  return buildEncryptedEnvBroadcast("provider_quota", plaintext, deps);
}

export function buildSessionLiveBroadcast(
  deps: EnvBroadcastDeps & { op: "upsert" | "end"; session: Record<string, unknown> },
): BroadcastFrame {
  const plaintext = ENC.encode(JSON.stringify({ op: deps.op, session: deps.session }));
  return buildEncryptedEnvBroadcast("session_live", plaintext, deps);
}

export function buildAgentProgressBroadcast(
  deps: EnvBroadcastDeps & { plaintext: Uint8Array },
): BroadcastFrame {
  return buildEncryptedEnvBroadcast("agent_progress", deps.plaintext, deps);
}

export function decodeEnvEntries(raw: unknown): EnvBroadcastEntries | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.sender_device_id !== "string") return null;
  if (typeof v.salt !== "string") return null;
  if (!Array.isArray(v.entries)) return null;
  const entries: EnvBroadcastEntries["entries"] = [];
  for (const e of v.entries) {
    if (typeof e !== "object" || e === null) return null;
    const entry = e as Record<string, unknown>;
    if (
      typeof entry.device_id !== "string" ||
      typeof entry.n !== "string" ||
      typeof entry.ct !== "string"
    ) {
      return null;
    }
    entries.push({ device_id: entry.device_id, n: entry.n, ct: entry.ct });
  }
  return { sender_device_id: v.sender_device_id, salt: v.salt, entries };
}
