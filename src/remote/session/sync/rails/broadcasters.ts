import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { loadAll as loadCredentials } from "@/kernel/storage/credentials.ts";
import {
  fetchUsageSnapshot,
  latestContextUsageSnapshotFromSessionRecords,
  usageByProviderFromRecords,
} from "@/kernel/storage/provider-usage.ts";
import type { RealtimeChannel } from "@/remote/_infra/realtime.ts";
import type { Device } from "@/remote/devices/device.ts";
import { listPeers } from "@/remote/devices/peers.ts";
import { getSessionSyncStatus } from "../session-status.ts";
import {
  buildAgentProgressBroadcast,
  buildAvailableModelsBroadcast,
  buildEncryptedEnvBroadcast,
  buildProviderQuotaBroadcast,
  buildSessionLiveBroadcast,
} from "./broadcast.ts";
import { buildPresenceBroadcast } from "./presence.ts";
import { compileAvailableModels, sessionLivePayload } from "./snapshot.ts";

const ENC = new TextEncoder();
const SALT_LEN = 32;

export interface Broadcasters {
  availableModels(): Promise<void>;
  sessionLive(op: "upsert" | "end"): void;
  sessionStats(): void;
  providerQuota(): Promise<void>;
  presence(online: boolean): void;
  agentProgress(plaintext: string): Promise<void>;
}

export function createBroadcasters(
  getChannel: () => RealtimeChannel | null,
  device: Device,
  session: Session,
  broker: Broker,
): Broadcasters {
  const availableModels = async (): Promise<void> => {
    const channel = getChannel();
    if (!channel) return;
    const peers = listPeers();
    if (peers.length === 0) return;
    const credentials = await loadCredentials();
    const frame = buildAvailableModelsBroadcast({
      providers: compileAvailableModels(credentials),
      peers,
      senderPriv: device.priv,
      senderDeviceId: device.id,
      salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
    });
    channel.send(frame);
  };
  const sessionLive = (op: "upsert" | "end"): void => {
    const channel = getChannel();
    if (!channel) return;
    const peers = listPeers();
    if (peers.length === 0) return;
    const payload =
      op === "end"
        ? { id: session.id }
        : sessionLivePayload({
            device,
            session,
            broker,
            sessionSyncStatus: getSessionSyncStatus(),
          });
    channel.send(
      buildSessionLiveBroadcast({
        op,
        session: payload,
        peers,
        senderPriv: device.priv,
        senderDeviceId: device.id,
        salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
      }),
    );
  };
  const sessionStats = (): void => {
    const channel = getChannel();
    if (!channel) return;
    const peers = listPeers();
    if (peers.length === 0) return;
    const snap = latestContextUsageSnapshotFromSessionRecords(
      session.records,
      undefined,
      session.usageRecords,
    );
    if (!snap) return;
    const contextTokens =
      snap.inputTokens +
      snap.cacheCreationInputTokens +
      snap.cacheReadInputTokens +
      snap.outputTokens;
    const plaintext = ENC.encode(
      JSON.stringify({
        // session_id disambiguates concurrent sessions on one device — the env
        // channel is device-scoped, so device-keyed stats flicker between
        // sessions on every heartbeat.
        session_id: session.id,
        input: snap.inputTokens,
        output: snap.outputTokens,
        cacheRead: snap.cacheReadInputTokens,
        cacheCreate: snap.cacheCreationInputTokens,
        contextTokens,
      }),
    );
    channel.send(
      buildEncryptedEnvBroadcast("session_stats", plaintext, {
        peers,
        senderPriv: device.priv,
        senderDeviceId: device.id,
        salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
      }),
    );
  };
  const providerQuota = async (): Promise<void> => {
    const channel = getChannel();
    if (!channel) return;
    const peers = listPeers();
    if (peers.length === 0) return;
    const currentUsage = usageByProviderFromRecords([...session.records, ...session.usageRecords]);
    const snapshot = await fetchUsageSnapshot(currentUsage);
    channel.send(
      buildProviderQuotaBroadcast({
        snapshot,
        sessionId: session.id,
        peers,
        senderPriv: device.priv,
        senderDeviceId: device.id,
        salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
      }),
    );
  };
  const presence = (online: boolean): void => {
    const channel = getChannel();
    if (!channel) return;
    const peers = listPeers();
    if (peers.length === 0) return;
    try {
      channel.send(
        buildPresenceBroadcast({
          kind: "cli",
          online,
          peers,
          senderPriv: device.priv,
          senderDeviceId: device.id,
          salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
        }),
      );
    } catch {}
  };
  const agentProgress = (plaintext: string): Promise<void> => {
    const channel = getChannel();
    if (!channel) return Promise.resolve();
    const peers = listPeers();
    if (peers.length === 0) return Promise.resolve();
    try {
      channel.send(
        buildAgentProgressBroadcast({
          plaintext: ENC.encode(plaintext),
          peers,
          senderPriv: device.priv,
          senderDeviceId: device.id,
          salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
        }),
      );
    } catch {}
    return Promise.resolve();
  };

  return { availableModels, sessionLive, sessionStats, providerQuota, presence, agentProgress };
}
