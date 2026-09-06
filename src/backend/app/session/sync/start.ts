import {
  listPeers,
  loadPeer,
  registerDeviceEnvironment,
  removeLocalPeerFile,
  retireRemotePairings,
} from "@/backend/app/peers.ts";
import { shareSessionKey } from "@/backend/shared/api.ts";
import {
  clearAuth,
  decodeUserId,
  forceRefreshAuth,
  isRefreshRejected,
  loadFreshAuth,
} from "@/backend/shared/auth.ts";
import type { Device } from "@/backend/shared/device.ts";
import { b64uDecode, unwrapEnvBroadcast, wrapSessionKey } from "@/backend/shared/e2ee.ts";
import {
  type BroadcastFrame,
  type RealtimeChannel,
  subscribeChannel,
} from "@/backend/shared/realtime.ts";
import {
  authFailureStatus,
  ensureSessionKey,
  hasRemoteDeletionMarker,
  isHttpError,
  loadSyncedAnchor,
  persistRemoteDeletionMarker,
  persistSyncedAnchor,
  probeAuth,
  type RatchetCacheEntry,
  SESSION_DELETED_CODE,
  SESSION_NOT_FOUND_CODE,
  sendEncryptedEvent,
} from "@/backend/shared/session-crypto.ts";
import {
  type BackgroundTaskState,
  listBackgroundTasks,
  subscribeBackgroundTaskCompletion,
  subscribeBackgroundTasks,
} from "@/kernel/channels/background-tasks.ts";
import { sleep } from "@/kernel/std/sleep.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { getSessionTitle, sessionTitleStore } from "@/store/session-title/index.ts";
import {
  isRemoteSyncSuspended,
  recordBootstrapFailure,
  resetBootstrapFailures,
} from "./bootstrap.ts";
import { adoptSyncCursor, EMPTY_SYNC_CURSOR, resumeIndexFor } from "./cursor.ts";
import {
  bgCompletionStatus,
  clearActiveEmitters,
  setActiveEnvEmitter,
  setActivePushEmitter,
} from "./events.ts";
import { emitQueueReset } from "./queue-drain.ts";
import { decodeEnvEntries } from "./rails/broadcast.ts";
import { createBroadcasters } from "./rails/broadcasters.ts";
import {
  type CancelQueuedMessageHandler,
  type IncomingSyncState,
  type OutgoingSyncResult,
  type QueuedMessageHandler,
  syncIncomingEvents,
  syncOutgoingEvents,
} from "./rails/durable.ts";
import { sendHeartbeat } from "./rails/heartbeat.ts";
import {
  deleteSessionRow,
  patchSessionRow,
  remoteSessionExists,
  sessionModelFields,
} from "./session-api.ts";
import {
  registerRemoteSession,
  setActiveSyncSessionId,
  setSessionRegistered,
  setSessionStatus,
  setSessionTitle,
} from "./session-status.ts";
import { markRemoteUnauthorized, notifyRemoteInvalidated, setSyncStatus } from "./status.ts";

const DEC = new TextDecoder();
const PRESENCE_EVENT = "presence";
const REVOKE_EVENT = "revoke";

const AUTH_BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_AUTH_RETRIES = AUTH_BACKOFF_MS.length;
const AUTH_BACKOFF_MAX_MS = AUTH_BACKOFF_MS[AUTH_BACKOFF_MS.length - 1] ?? 8000;

export interface SyncHandle {
  stop(): void;
}

export async function startSync(
  device: Device,
  session: Session,
  broker: Broker,
  opts?: {
    onIncomingMessage?: (text: string, blocks?: ContentBlock[]) => void;
    onQueuedMessage?: QueuedMessageHandler;
    onCancelQueuedMessage?: CancelQueuedMessageHandler;
  },
): Promise<SyncHandle | null> {
  if (listPeers().length === 0) return null;
  if (isRemoteSyncSuspended()) return null;
  if (hasRemoteDeletionMarker(session.id)) {
    setSessionRegistered(false);
    setSyncStatus("disconnected");
    return null;
  }

  setSyncStatus("connecting");

  const auth = await loadFreshAuth();
  if (!auth) {
    if (isRefreshRejected()) {
      clearAuth();
      notifyRemoteInvalidated();
    }
    setSyncStatus("disconnected");
    return null;
  }

  const userId = decodeUserId(auth.accessToken);
  if (!userId) {
    setSyncStatus("disconnected");
    return null;
  }

  let accessToken = auth.accessToken;
  let sessionUnauthorized = false;
  let sessionClosed = false;
  const suspendRemote = (status: 401 | 403): void => {
    sessionUnauthorized = true;
    markRemoteUnauthorized(status);
  };

  setActiveSyncSessionId(session.id);

  try {
    device = await registerDeviceEnvironment(device);
    resetBootstrapFailures();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordBootstrapFailure(`registerEnvironment: ${message}`);
    setSyncStatus("disconnected");
    if (isRemoteSyncSuspended()) return null;
  }

  const hasMessages = (s: Session): boolean => {
    return s.records.some((r) => r.type === "user_message" || r.type === "assistant_message");
  };

  const sessionKey = ensureSessionKey(session.id);
  let hasRegistered = false;

  const outgoingRatchet = new Map<string, RatchetCacheEntry>();
  const sendEvent = (eventType: string, plaintext: string): Promise<void> =>
    sendEncryptedEvent({
      device,
      session,
      userId,
      accessToken,
      sessionKey,
      ratchet: outgoingRatchet,
      eventType,
      plaintext,
    }).then(() => {});

  let channel: RealtimeChannel | null = null;
  const broadcasters = createBroadcasters(() => channel, device, session, broker);

  const bootstrapSessionOnBackend = async (): Promise<void> => {
    // Probe before upsert so a missing remote incarnation can reseed from the
    // canonical local transcript instead of treating prior progress as current.
    const hadSyncedHistory = loadSyncedAnchor(session.id) !== null;
    const priorRowExists = hadSyncedHistory
      ? await remoteSessionExists(session.id, accessToken)
      : true;

    try {
      await registerRemoteSession(device, session, broker, accessToken);
      setSessionRegistered(true);
      resetBootstrapFailures();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordBootstrapFailure(`registerRemoteSession: ${message}`);
      throw err;
    }

    // Only rewind on a definite "row is gone" — never on an unknown (null)
    // probe, which would needlessly re-upload the full history.
    if (priorRowExists === false) {
      persistSyncedAnchor(session.id, null);
      lastSyncedCursor = EMPTY_SYNC_CURSOR;
    }

    const peers = listPeers();
    const keyEntries = [];
    for (const peer of peers) {
      const wrapped = wrapSessionKey({
        senderPriv: device.priv,
        peerPub: peer.pub,
        sessionId: session.id,
        senderDeviceId: device.id,
        peerDeviceId: peer.deviceId,
        sessionKey,
      });
      keyEntries.push({
        device_id: peer.deviceId,
        sender_device_id: device.id,
        wrapped,
      });
    }
    if (keyEntries.length > 0) {
      try {
        await shareSessionKey({
          session_id: session.id,
          entries: keyEntries,
        });
      } catch (err) {
        recordBootstrapFailure(
          `shareSessionKey: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await sendEvent("session_start", "{}");
    sendTasksUpdate();
  };

  const applyPresenceBroadcast = async (raw: unknown): Promise<void> => {
    if (sessionClosed) return;
    const env = decodeEnvEntries(raw);
    if (!env) return;
    const entry = env.entries.find((e) => e.device_id === device.id);
    if (!entry) return;
    const peer = loadPeer(env.sender_device_id);
    if (!peer || peer.kind !== "app") return;
    let plaintext: Uint8Array;
    try {
      plaintext = unwrapEnvBroadcast({
        recipientPriv: device.priv,
        senderPub: peer.pub,
        salt: b64uDecode(env.salt),
        senderDeviceId: env.sender_device_id,
        recipientDeviceId: device.id,
        wrapped: { v: 1, n: entry.n, ct: entry.ct },
      });
    } catch {
      return;
    }
    const presence = JSON.parse(DEC.decode(plaintext)) as {
      kind?: string;
      online?: boolean;
    };
    if (presence.kind === "app" && presence.online) {
      void broadcasters.availableModels().catch(() => {});
      broadcasters.sessionLive("upsert");
      broadcasters.sessionStats();
      void broadcasters.providerQuota().catch(() => {});
    }
  };
  const handleEnvBroadcast = (frame: BroadcastFrame): void => {
    if (frame.event === REVOKE_EVENT) {
      const revoked = frame.payload as { cli_device_id?: string };
      if (revoked.cli_device_id === device.id) {
        // App-side revoke removes the pairing, never the sign-in: the same
        // login serves the design relay. Drop local peer/identity state only.
        for (const peer of listPeers()) removeLocalPeerFile(peer.deviceId);
        retireRemotePairings();
        setSyncStatus("disconnected");
        notifyRemoteInvalidated();
      }
      return;
    }
    if (frame.event !== PRESENCE_EVENT) return;
    void applyPresenceBroadcast(frame.payload).catch(() => {});
  };

  try {
    channel = await subscribeChannel({
      topic: `user:${userId}:env`,
      accessToken: async () => {
        const freshAuth = await loadFreshAuth();
        if (freshAuth) {
          accessToken = freshAuth.accessToken;
          return freshAuth.accessToken;
        }
        return accessToken;
      },
      onBroadcast: handleEnvBroadcast,
      onReconnect: () => {
        if (!channel || sessionClosed) return;
        broadcasters.presence(true);
        void broadcasters.availableModels().catch(() => {});
        broadcasters.sessionLive("upsert");
        broadcasters.sessionStats();
        void broadcasters.providerQuota().catch(() => {});
      },
    });
    broadcasters.presence(true);
  } catch {
    setActiveSyncSessionId(null);
    setSyncStatus("disconnected");
    return null;
  }

  void broadcasters.availableModels().catch(() => {});
  broadcasters.sessionLive("upsert");
  broadcasters.sessionStats();
  void broadcasters.providerQuota().catch(() => {});

  setActivePushEmitter((eventType, plaintext) =>
    hasRegistered ? sendEvent(eventType, plaintext) : Promise.resolve(),
  );
  setActiveEnvEmitter((plaintext) =>
    hasRegistered ? broadcasters.agentProgress(plaintext) : Promise.resolve(),
  );

  let lastSyncedCursor = adoptSyncCursor(session);
  let outgoingSyncActive = false;
  const incomingState: IncomingSyncState = {
    cursorTs: null,
    processed: new Set(),
    ratchet: new Map(),
    watermark: new Map(),
  };

  let eventsChannel: RealtimeChannel | null = null;
  let eventsStopped = false;
  let syncInterval: Timer | null = null;
  let heartbeatInterval: Timer | null = null;
  let quotaInterval: Timer | null = null;
  void subscribeChannel({
    topic: `session:${session.id}:events`,
    accessToken: async () => {
      const freshAuth = await loadFreshAuth();
      if (freshAuth) {
        accessToken = freshAuth.accessToken;
        return freshAuth.accessToken;
      }
      return accessToken;
    },
    onReconnect: () => {
      void runSyncTick();
    },
  })
    .then((ch) => {
      if (eventsStopped) {
        ch.close();
        return;
      }
      eventsChannel = ch;
    })
    .catch(() => {});

  const prepareRemoteReseed = (): void => {
    persistSyncedAnchor(session.id, null);
    lastSyncedCursor = EMPTY_SYNC_CURSOR;
    hasRegistered = false;
    setSessionRegistered(false);
    setSyncStatus("connecting");
  };

  const stopDeletedRemote = (): void => {
    persistRemoteDeletionMarker(session.id);
    sessionClosed = true;
    hasRegistered = false;
    setSessionRegistered(false);
    clearActiveEmitters();
    setActiveSyncSessionId(null);
    setSyncStatus("disconnected");
    if (syncInterval) clearInterval(syncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (quotaInterval) clearInterval(quotaInterval);
    eventsStopped = true;
    if (eventsChannel) {
      eventsChannel.close();
      eventsChannel = null;
    }
  };

  const pushOutgoing = (): void => {
    if (sessionClosed || outgoingSyncActive) return;
    outgoingSyncActive = true;
    void pushOutgoingWithBackoff().finally(() => {
      outgoingSyncActive = false;
    });
  };
  const pushOutgoingWithBackoff = async (): Promise<void> => {
    let attempt = 0;
    while (true) {
      let result: OutgoingSyncResult;
      try {
        result = await syncOutgoingEvents({
          device,
          session,
          userId,
          accessToken,
          sessionKey,
          ratchet: outgoingRatchet,
          fromIndex: resumeIndexFor(session, lastSyncedCursor),
          cursor: lastSyncedCursor,
        });
      } catch {
        return;
      }
      lastSyncedCursor = result.cursor;

      if (result.rejected) {
        recordBootstrapFailure(`syncOutgoingEvents: rejected (${result.rejected})`);
        if (result.rejected === SESSION_DELETED_CODE) {
          stopDeletedRemote();
          return;
        }
        if (result.rejected === SESSION_NOT_FOUND_CODE) {
          prepareRemoteReseed();
          return;
        }
        hasRegistered = false;
        setSessionRegistered(false);
        setSyncStatus("connecting");
        return;
      }
      if (result.retryable) {
        return;
      }
      if (result.authStatus === null) return;
      if (attempt >= MAX_AUTH_RETRIES) {
        suspendRemote(result.authStatus);
        return;
      }
      await sleep(AUTH_BACKOFF_MS[attempt] ?? AUTH_BACKOFF_MAX_MS);
      attempt += 1;
      const forced = await forceRefreshAuth(accessToken);
      if (!forced) {
        suspendRemote(result.authStatus);
        return;
      }
      accessToken = forced.accessToken;
    }
  };

  let lastSyncedTitle = getSessionTitle();
  let pendingTitle: string | null = null;
  let titleSyncActive = false;

  const queueCurrentTitle = (): void => {
    const title = getSessionTitle();
    pendingTitle = title && title !== lastSyncedTitle ? title : null;
  };

  const flushPendingTitle = async (): Promise<void> => {
    if (titleSyncActive || !hasRegistered || !pendingTitle) return;
    titleSyncActive = true;
    try {
      while (hasRegistered && pendingTitle) {
        const title = pendingTitle;
        if (!(await setSessionTitle(title))) return;
        lastSyncedTitle = title;
        queueCurrentTitle();
      }
    } finally {
      titleSyncActive = false;
    }
  };

  let queueResetSent = false;
  const tryBootstrap = (): void => {
    if (sessionClosed || hasRegistered) return;
    hasRegistered = true;
    void bootstrapSessionOnBackend()
      .then(() => {
        setSyncStatus("active");
        queueCurrentTitle();
        void flushPendingTitle();
        // First registration of this process: the local queue is empty by
        // definition, so tell paired clients to drop stale ledger entries.
        // Re-registrations (auth refresh) must NOT reset a live queue.
        if (!queueResetSent) {
          queueResetSent = true;
          emitQueueReset();
        }
        pushOutgoing();
      })
      .catch(async (err) => {
        if (
          isHttpError(err) &&
          (err.httpStatus === 410 || err.errorCode === SESSION_DELETED_CODE)
        ) {
          stopDeletedRemote();
          return;
        }
        hasRegistered = false;
        setSessionRegistered(false);
        setSyncStatus("connecting");
        if (isHttpError(err)) {
          const status = authFailureStatus(err.httpStatus);
          if (status !== null) {
            // A bootstrap 401/403 only means the TOKEN died when the token
            // fails everywhere. A valid token with a refused registration is
            // a session-ownership conflict: keep the pairing, keep retrying
            // (bootstrap failure accounting caps and surfaces it).
            const tokenAccepted = await probeAuth(accessToken);
            if (tokenAccepted === false) suspendRemote(status);
          }
        }
      });
  };

  // Status stays "connecting" until the bootstrap actually lands — it flips
  // to "active" inside tryBootstrap's success path, never optimistically.
  tryBootstrap();

  const runSyncTick = async (): Promise<void> => {
    if (sessionClosed) return;
    const fresh = await loadFreshAuth();
    if (!fresh) return;
    accessToken = fresh.accessToken;
    if (!hasRegistered) {
      // Bootstrap suspension (failure cap) must stop the retry hammering and
      // surface honestly — a dead sync that still reads "active" is the lie
      // that made a companion-deleted session invisible while the CLI looked
      // healthy.
      if (isRemoteSyncSuspended()) {
        setSyncStatus("disconnected");
        return;
      }
      tryBootstrap();
      return;
    }
    const inStatus = await syncIncomingEvents({
      device,
      session,
      accessToken,
      sessionKey,
      broker,
      state: incomingState,
      onIncomingMessage: opts?.onIncomingMessage,
      onQueuedMessage: opts?.onQueuedMessage,
      onCancelQueuedMessage: opts?.onCancelQueuedMessage,
    });
    if (inStatus === 404) {
      prepareRemoteReseed();
      return;
    }
    if (inStatus === 410) {
      stopDeletedRemote();
      return;
    }
    if (inStatus !== null) {
      suspendRemote(inStatus);
      return;
    }
    queueCurrentTitle();
    void flushPendingTitle();
    pushOutgoing();
  };

  syncInterval = setInterval(() => {
    if (sessionUnauthorized || sessionClosed) {
      if (syncInterval) clearInterval(syncInterval);
      return;
    }
    void runSyncTick().catch(() => {});
  }, 2000);

  const sendTasksUpdate = () => {
    if (!hasRegistered) return;
    void sendEvent("tasks_update", JSON.stringify({ tasks: listBackgroundTasks() })).catch(
      () => {},
    );
  };

  const unsubscribeBgCompletion = subscribeBackgroundTaskCompletion((task) => {
    if (!task.isBackgrounded || !hasRegistered) return;
    void sendEvent(
      "bg_completion",
      JSON.stringify({
        call_id: task.parentToolCallId,
        agent: task.agentName,
        description: task.description ?? "",
        status: bgCompletionStatus(task.status as BackgroundTaskState),
      }),
    ).catch(() => {});
  });

  let tasksTimeout: Timer | null = null;
  const unsubscribeTasks = subscribeBackgroundTasks(() => {
    if (tasksTimeout) clearTimeout(tasksTimeout);
    tasksTimeout = setTimeout(() => {
      tasksTimeout = null;
      sendTasksUpdate();
    }, 100);
  });

  const unsubscribeTitle = sessionTitleStore.subscribe(() => {
    queueCurrentTitle();
    void flushPendingTitle();
  });

  let lastBrokerState = broker.read();
  const unsubscribeBroker = broker.subscribe((brokerState) => {
    if (sessionClosed) return;
    if (
      brokerState.provider === lastBrokerState.provider &&
      brokerState.model === lastBrokerState.model &&
      brokerState.permissionMode === lastBrokerState.permissionMode
    ) {
      return;
    }
    lastBrokerState = brokerState;

    if (!hasRegistered) {
      broadcasters.sessionLive("upsert");
      return;
    }

    void patchSessionRow(session.id, accessToken, {
      ...sessionModelFields(broker),
    }).catch(() => {});

    void broadcasters.availableModels().catch(() => {});
  });

  const live = channel;
  heartbeatInterval = setInterval(() => {
    if (sessionUnauthorized || sessionClosed) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      return;
    }
    if (hasRegistered) {
      void sendHeartbeat(device, session, broker).catch(() => {});
    }
    broadcasters.sessionStats();
  }, 20000);

  // Provider quota polls live usage APIs, so it runs on a slower cadence than
  // the session heartbeat to avoid hammering those endpoints.
  quotaInterval = setInterval(() => {
    if (sessionUnauthorized || sessionClosed) {
      if (quotaInterval) clearInterval(quotaInterval);
      return;
    }
    void broadcasters.providerQuota().catch(() => {});
  }, 60000);

  return {
    stop() {
      if (resumeIndexFor(session, lastSyncedCursor) < session.records.length) {
        pushOutgoing();
      }
      clearActiveEmitters();
      unsubscribeBgCompletion();
      unsubscribeTasks();
      if (tasksTimeout) clearTimeout(tasksTimeout);
      unsubscribeTitle();
      unsubscribeBroker();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (quotaInterval) clearInterval(quotaInterval);
      if (syncInterval) clearInterval(syncInterval);
      if (!sessionClosed) {
        if (hasRegistered && !hasMessages(session)) {
          void deleteSessionRow(session.id, accessToken).catch(() => {});
        } else {
          void setSessionStatus("disconnected").catch(() => {});
        }
        if (!hasRegistered) {
          try {
            broadcasters.sessionLive("end");
          } catch {}
        }
      }
      setActiveSyncSessionId(null);
      setSyncStatus("disconnected");
      try {
        broadcasters.presence(false);
      } catch {}
      eventsStopped = true;
      if (eventsChannel) eventsChannel.close();
      live.close();
    },
  };
}
