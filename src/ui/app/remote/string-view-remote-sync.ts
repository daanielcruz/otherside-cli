import {
  ensureDevice,
  getActiveSyncSessionId,
  getRemoteSyncStatus,
  initRemoteSession,
  isRemoteEnabled,
  isRemoteSyncSuspended,
  listPeers,
  removeLegacyRemoteSessionState,
  type SyncHandle,
  startSync,
  subscribeRemoteState,
} from "@/backend/index.ts";
import {
  appendRecord,
  nowIso,
  type Session,
  sessionMetaFromBrokerState,
} from "@/engine/session/index.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  getQueueMessages,
  type QueuedMessage,
  queueActions,
  queueIdFromPayload,
} from "@/store/queue-store/index.ts";
import { runningRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";

const REMOTE_SYNC_POLL_MS = 1500;

// The queue-vs-dispatch decision, pulled out for unit testing. Mirrors the
// local-input gate: a live turn queues the message instead of racing a
// concurrent dispatch through runSubmittedTurnRef.
export function routeIncomingMessage(
  isTurnLive: boolean,
  text: string,
  blocks: ContentBlock[] | undefined,
  handlers: {
    queue: (text: string, blocks?: ContentBlock[]) => void;
    dispatch: (text: string, opts: { blocks?: ContentBlock[]; isRemote?: boolean }) => void;
  },
): void {
  if (isTurnLive) {
    handlers.queue(text, blocks);
    return;
  }
  const opts: { blocks?: ContentBlock[]; isRemote?: boolean } = { isRemote: true };
  if (blocks) opts.blocks = blocks;
  handlers.dispatch(text, opts);
}

export interface RemoteSyncDeps {
  session: Session;
  broker: Broker;
}

/**
 * Keeps the session's remote sync alive for the paired companion devices:
 * boots the remote session state, starts the sync whenever remote is enabled
 * with at least one peer, routes incoming remote messages through the same
 * gate as local input, and stops the sync on deactivate.
 */
export function activateStringViewRemoteSync(deps: RemoteSyncDeps): () => void {
  const { session, broker } = deps;

  const pushRemoteQueued = (text: string, blocks?: ContentBlock[], payload?: unknown): void => {
    const queueId = queueIdFromPayload(payload);
    const msg: QueuedMessage = {
      id: queueId ?? `qr_${Date.now()}_${getQueueMessages().length}`,
      text,
      expanded: text,
      blocks: blocks ?? [{ type: "text", text }],
      remotePayload: payload,
    };
    queueActions.pushUnique(msg);
  };

  // Persist the session's activation into its own transcript metadata so it
  // survives resume. Legacy pre-metadata activation files are adopted once,
  // re-homed into the transcript, and removed. A null marker suppresses
  // change-persistence until the restored value is resolved — init's own
  // notification must never write a record.
  let persistedRemoteEnabled: boolean | null = null;
  const source = initRemoteSession(session.id, session.records);
  if (source === "legacy" && session.records.length > 0) {
    void appendRecord(session, sessionMetaFromBrokerState(session, broker.read(), nowIso())).catch(
      () => {},
    );
  }
  if (source !== "default") removeLegacyRemoteSessionState(session.id);
  persistedRemoteEnabled = isRemoteEnabled();

  let activeSync: SyncHandle | null = null;
  let starting = false;
  let deactivated = false;

  const checkSync = async (): Promise<void> => {
    if (deactivated || starting) return;
    if (isRemoteSyncSuspended()) return;
    const enabled = isRemoteEnabled();
    const peers = listPeers();
    const status = getRemoteSyncStatus();

    if (enabled && peers.length > 0) {
      if (activeSync && session.id !== getActiveSyncSessionId()) {
        activeSync.stop();
        activeSync = null;
      }
      if (status === "disconnected" && !activeSync) {
        starting = true;
        try {
          activeSync = await startSync(ensureDevice(), session, broker, {
            onIncomingMessage: (text, blocks) => {
              routeIncomingMessage(runningRef.current, text, blocks, {
                queue: pushRemoteQueued,
                dispatch: (t, opts) => void runSubmittedTurnRef.current?.(t, opts),
              });
            },
            onQueuedMessage: pushRemoteQueued,
            onCancelQueuedMessage: (message) => {
              if (message.queueId) {
                queueActions.removeById(message.queueId);
              } else {
                queueActions.removeFirstByText(message.text);
              }
            },
          });
          if (deactivated && activeSync) {
            activeSync.stop();
            activeSync = null;
          }
        } finally {
          starting = false;
        }
      }
    } else if (activeSync) {
      activeSync.stop();
      activeSync = null;
    }
  };

  // Activation changes (panel toggle, pairing, retirement) persist to the
  // transcript at the moment they happen; the birth default rides the
  // session's first pending meta instead, so untouched sessions never create
  // a transcript file just to record it.
  const persistRemoteEnabled = (): void => {
    const enabled = isRemoteEnabled();
    if (persistedRemoteEnabled === null) return;
    if (persistedRemoteEnabled === enabled) return;
    persistedRemoteEnabled = enabled;
    void appendRecord(session, sessionMetaFromBrokerState(session, broker.read(), nowIso())).catch(
      () => {},
    );
  };

  const unsubscribeState = subscribeRemoteState(() => {
    persistRemoteEnabled();
    void checkSync();
  });

  const poll = setInterval(() => void checkSync(), REMOTE_SYNC_POLL_MS);
  poll.unref();
  void checkSync();

  return () => {
    deactivated = true;
    clearInterval(poll);
    unsubscribeState();
    if (activeSync) {
      activeSync.stop();
      activeSync = null;
    }
  };
}
