import { buildRpcContext } from "@/design/bridge/context.ts";
import { buildMethodTable, type MethodTable } from "@/design/bridge/dispatch.ts";
import { encode, fail, notify, RPC_INTERNAL_ERROR } from "@/design/bridge/envelope.ts";
import { scrub } from "@/design/bridge/scrubber.ts";
import { providers } from "@/design/capabilities/meta-list.ts";
import { DESIGN_CAPABILITIES } from "@/design/capabilities.ts";
import { setDesignPushHook } from "@/design/push-hook.ts";
import { shareKeyWithWeb } from "@/design/relay/attach.ts";
import { startDurablePoll } from "@/design/relay/durable-poll.ts";
import { createInboundState, handleRelayRow } from "@/design/relay/inbound.ts";
import { createOutbound } from "@/design/relay/outbound.ts";
import { createTokenRefresher } from "@/design/relay/token-refresh.ts";
import {
  designSessionAlive,
  designWebUrl,
  endProjectSessions,
  ensureDesignProject,
  patchProjectVersion,
  registerDesignSession,
  setDesignSessionStatus,
  touchDesignSession,
} from "@/design/relay/wire.ts";
import { createDesignSnapshot } from "@/design/snapshot.ts";
import { markAttached, markLinkExpired, setSpawnLink } from "@/design/spawn-registry.ts";
import { loadDesignSnapshot, saveDesignSnapshot } from "@/design/storage.ts";
import type {
  DesignSnapshot,
  DesignSpawn,
  JsonRpcNotification,
  JsonRpcResponse,
} from "@/design/types.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import { type RealtimeChannel, subscribeChannel } from "@/remote/_infra/realtime.ts";
import {
  listSessionEvents,
  mintDesignOpenToken,
  registerEnvironment,
} from "@/remote/backend/api.ts";
import { currentUserEmail, currentUserId, loadFreshAuth } from "@/remote/backend/auth.ts";
import { oauthLogin } from "@/remote/backend/oauth.ts";
import { b64uEncode } from "@/remote/crypto/e2ee.ts";
import { deviceFingerprint, ensureDevice } from "@/remote/devices/device.ts";
import { ensureSessionKey, type RatchetCacheEntry } from "@/remote/session/sync/crypto.ts";
import { appPermissionMode } from "@/remote/session/sync/snapshot.ts";
import type { Broker } from "@/store/app-store/broker.ts";

const DESIGN_HEARTBEAT_INTERVAL_MS = 20_000;

export interface StartRelayArgs {
  spawnId: string;
  designId: string;
  initialPrompt?: string | undefined;
  session: Session;
  agent: Agent;
  cwd: string;
  version: string;
  broker: Broker;
}

export interface StartRelayResult {
  sessionHash: string;
  url: string;
  stop: () => Promise<void>;
  spawn: DesignSpawn;
}

export async function startDesignRelay(args: StartRelayArgs): Promise<StartRelayResult> {
  let auth = await loadFreshAuth();
  if (!auth) auth = await oauthLogin();
  if (!auth)
    throw new Error(
      "Otherside Design needs you to sign in — retry /design after the browser login",
    );
  const userId = currentUserId();
  if (!userId) throw new Error("Otherside Design could not resolve your account — sign in again");

  const device = ensureDevice();
  const { environment_id: envId } = await registerEnvironment({
    id: device.id,
    device_label: device.name,
    fingerprint_hash: deviceFingerprint(),
    kind: "cli",
  });
  const env = { ...device, id: envId };

  const designProjectId = await ensureDesignProject({
    accessToken: auth.accessToken,
    userId,
    designId: args.designId,
    environmentId: envId,
  });

  await endProjectSessions({ accessToken: auth.accessToken, designProjectId });

  const sessionHash = crypto.randomUUID();
  const brokerState = args.broker.read();
  await registerDesignSession({
    accessToken: auth.accessToken,
    userId,
    environmentId: envId,
    sessionHash,
    designProjectId,
    provider: brokerState.provider,
    model: brokerState.model,
    permissionMode: appPermissionMode(brokerState.permissionMode),
  });
  // Minting only needs the session (plus the CLI environment for ownership),
  // so a fresh open token can be re-minted for the SAME session while the
  // pairing link sits unused — no relay teardown when the token TTL passes.
  const cliPubB64 = b64uEncode(device.pub);
  const accountEmail = currentUserEmail() ?? undefined;
  const mintLink = async (): Promise<{ url: string; expiresAt: string }> => {
    const open = await mintDesignOpenToken({
      session_id: sessionHash,
      cli_environment_id: envId,
    });
    return {
      url: designWebUrl(open.token, cliPubB64, accountEmail),
      expiresAt: open.expires_at,
    };
  };
  const initialLink = await mintLink();

  const sessionKey = ensureSessionKey(sessionHash);
  const outgoingRatchet = new Map<string, RatchetCacheEntry>();
  const outbound = createOutbound({
    spawnId: args.spawnId,
    sessionHash,
    userId,
    sessionKey,
    deviceId: envId,
    ratchet: outgoingRatchet,
  });

  const persisted = loadDesignSnapshot(args.cwd, args.designId);
  const initialSnapshot =
    persisted ??
    createDesignSnapshot({
      designId: args.designId,
      initialPrompt: args.initialPrompt,
    });
  if (!persisted) saveDesignSnapshot(args.cwd, initialSnapshot);
  const snapshots = new Map<string, DesignSnapshot>([[args.designId, initialSnapshot]]);

  const send = (frame: JsonRpcResponse): void => {
    const json = encode(frame);
    const guard = scrub(json);
    if (!guard.ok) {
      outbound.sendFrame(encode(fail(frame.id, RPC_INTERNAL_ERROR, "scrubbed")));
      return;
    }
    outbound.sendFrame(json);
  };
  const emit = (frame: JsonRpcNotification): void => {
    const json = encode(frame);
    const guard = scrub(json);
    if (!guard.ok) {
      outbound.sendFrame(encode(notify("$/error", { code: "internal_error" })));
      return;
    }
    outbound.sendFrame(json);
  };

  const methodTable: MethodTable = buildMethodTable(DESIGN_CAPABILITIES);
  const ctx = buildRpcContext({
    broker: args.broker,
    session: args.session,
    agent: args.agent,
    cwd: args.cwd,
    codebaseRoot: args.cwd,
    sessionId: args.session.id,
    spawnId: args.spawnId,
    designId: args.designId,
    snapshots,
    port: 0,
    version: args.version,
    authorizedMethods: () => methodTable.names(),
    send,
    emit,
  });

  // Keep the pairing link fresh until the web attaches: the open token dies
  // after 5 minutes, so re-mint in place and push the new URL through the
  // spawn registry (the overlay swaps it live and restarts its countdown).
  let attached = false;
  const linkRefresher = createTokenRefresher({
    mint: mintLink,
    isAttached: () => attached,
    onUpdate: (nextUrl, expiresAt) => setSpawnLink(args.spawnId, nextUrl, expiresAt),
    onExhausted: () => markLinkExpired(args.spawnId),
    onError: (err) => {
      process.stderr.write(
        `design relay: link re-mint failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    },
  });
  setSpawnLink(args.spawnId, initialLink.url, initialLink.expiresAt);
  linkRefresher.schedule(initialLink.expiresAt);

  const inboundState = createInboundState();
  const onAttach = (webDeviceId: string, webPubB64: string, confirmTokenB64: string): void => {
    void shareKeyWithWeb({
      device: env,
      sessionHash,
      sessionKey,
      webDeviceId,
      webPubB64,
      confirmTokenB64,
    })
      .then(() => {
        attached = true;
        linkRefresher.stop();
        markAttached(args.spawnId);
      })
      .catch((err) => {
        process.stderr.write(
          `design relay: key share failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  };

  await outbound.postBootstrap(b64uEncode(device.pub));

  // Cortex has no CDC: "events.appended" is a durable notify with no body, so
  // inbound work is a poll of the events endpoint. Rows re-read across polls
  // are dropped by the inbound counter/dedupe state; only one poll runs at a
  // time and a notify landing mid-poll queues exactly one follow-up.
  let pollActive = false;
  let pollQueued = false;
  const pollEvents = async (): Promise<void> => {
    if (pollActive) {
      pollQueued = true;
      return;
    }
    pollActive = true;
    try {
      const rows = await listSessionEvents(sessionHash, 50);
      for (const row of [...rows].reverse()) {
        await handleRelayRow(row as unknown as Record<string, unknown>, {
          state: inboundState,
          sessionHash,
          sessionKey,
          selfDeviceId: envId,
          methodTable,
          ctx,
          onAttach,
        });
      }
    } catch (err) {
      process.stderr.write(
        `design relay: event poll failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      pollActive = false;
      if (pollQueued) {
        pollQueued = false;
        void pollEvents();
      }
    }
  };

  const channelToken = async (): Promise<string> => {
    const freshAuth = await loadFreshAuth();
    if (freshAuth) return freshAuth.accessToken;
    return auth.accessToken;
  };

  const channel: RealtimeChannel = await subscribeChannel({
    topic: `session:${sessionHash}:events`,
    accessToken: channelToken,
    private: true,
    onReconnect: () => {
      void pollEvents();
    },
  });

  // Pairing confirmation arrives as a broadcast on the pair room, not as a
  // durable event row — the web posts /v1/design/pair and cortex relays it.
  const pairChannel: RealtimeChannel = await subscribeChannel({
    topic: `pair:${sessionHash}`,
    accessToken: channelToken,
    onBroadcast: (frame) => {
      if (frame.event !== "confirm") return;
      const payload = frame.payload as {
        web_device_id?: string;
        web_pub?: string;
        confirm_token?: string;
      };
      if (
        typeof payload.web_device_id === "string" &&
        typeof payload.web_pub === "string" &&
        typeof payload.confirm_token === "string"
      ) {
        onAttach(payload.web_device_id, payload.web_pub, payload.confirm_token);
      }
    },
  });
  const stopDurablePoll = startDurablePoll(pollEvents);

  // The backend sweep flips a session to disconnected after 2min without an
  // updated_at bump and hard-deletes it 30min later, which kills the realtime
  // topic authorization. Keep the row alive for the whole relay lifetime and
  // re-register it if a sweep already removed it (self-heal, mobile pattern).
  const heartbeat = setInterval(() => {
    void (async () => {
      const freshAuth = await loadFreshAuth();
      const token = freshAuth?.accessToken ?? auth.accessToken;
      const alive = await designSessionAlive({ accessToken: token, sessionHash });
      if (alive) {
        await touchDesignSession({ accessToken: token, sessionHash });
        return;
      }
      const state = args.broker.read();
      await registerDesignSession({
        accessToken: token,
        userId,
        environmentId: envId,
        sessionHash,
        designProjectId,
        provider: state.provider,
        model: state.model,
        permissionMode: appPermissionMode(state.permissionMode),
      }).catch(() => {});
    })();
  }, DESIGN_HEARTBEAT_INTERVAL_MS);

  let version = 0;
  setDesignPushHook((_cwd, snapshot) => {
    if (snapshot.designId !== args.designId) return;
    version += 1;
    void patchProjectVersion({
      accessToken: auth.accessToken,
      designProjectId,
      version,
    });
  });

  const unsubscribeBroker = args.broker.subscribe(async (next) => {
    try {
      const snapshot = snapshots.get(args.designId);
      const provider = snapshot?.provider ?? next.provider;
      const model = snapshot?.model ?? next.model;
      const effort = snapshot?.effort !== undefined ? snapshot.effort : next.effort;
      const list = await providers(provider);
      emit(
        notify("$/metadata", {
          providers: list,
          current: { provider, model, effort },
        }),
      );
    } catch {}
  });

  const url = initialLink.url;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    linkRefresher.stop();
    stopDurablePoll();
    clearInterval(heartbeat);
    unsubscribeBroker();
    setDesignPushHook(null);
    try {
      channel.close();
    } catch {}
    try {
      pairChannel.close();
    } catch {}
    await setDesignSessionStatus({
      accessToken: auth.accessToken,
      sessionHash,
      status: "ended",
    });
  };

  const spawn: DesignSpawn = {
    id: args.spawnId,
    sessionId: args.session.id,
    sessionHash,
    cwd: args.cwd,
    session: args.session,
    agent: args.agent,
    designId: args.designId,
    snapshots,
    url,
    version: args.version,
    startedAt: Date.now(),
    attached: false,
    broker: args.broker,
    stop,
  };

  return { sessionHash, url, stop, spawn };
}
