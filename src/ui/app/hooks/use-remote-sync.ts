import { useCallback, useEffect, useRef } from "react";
import type { Session } from "@/engine/session/index.ts";
import { useRepeatingClock } from "@/ink";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import {
  ensureDevice,
  getActiveSyncSessionId,
  getRemoteSyncStatus,
  initRemoteSession,
  isAutoEnable,
  isRemoteEnabled,
  isRemoteSyncSuspended,
  listPeers,
  type SyncHandle,
  setRemoteEnabled,
  startSync,
  subscribeRemoteState,
} from "@/remote/index.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  getQueueMessages,
  type QueuedMessage,
  queueActions,
  queueIdFromPayload,
} from "@/store/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";

const REMOTE_SYNC_POLL_MS = 1500;
const noop = (): void => {};

type RunSubmittedTurn = (
  text: string,
  opts?: {
    blocks?: ContentBlock[];
    additionalContext?: string[];
    suppressUserTranscript?: boolean;
    isRemote?: boolean;
    restoreEntryId?: string;
  },
) => Promise<void>;

export interface RemoteSyncDeps {
  session: Session;
  broker: Broker;
  runSubmittedTurnRef: { current: RunSubmittedTurn };
}

// Pulled out of the onIncomingMessage callback so the queue-vs-dispatch decision
// is unit-testable without a React render harness. Mirrors the local-input gate
// in dispatch/loop.ts: a live turn queues the message instead of racing a
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

export function useRemoteSync(deps: RemoteSyncDeps): void {
  const { session, broker, runSubmittedTurnRef } = deps;

  const pushRemoteQueued = useCallback(
    (text: string, blocks?: ContentBlock[], payload?: unknown): void => {
      const queueId = queueIdFromPayload(payload);
      const msg: QueuedMessage = {
        id: queueId ?? `qr_${Date.now()}_${getQueueMessages().length}`,
        text,
        expanded: text,
        blocks: blocks ?? [{ type: "text", text }],
        remotePayload: payload,
      };
      queueActions.pushUnique(msg);
    },
    [],
  );

  const checkRemoteSyncRef = useRef<() => void>(noop);

  useEffect(() => {
    initRemoteSession(session.id);
    if (isAutoEnable() && !isRemoteEnabled()) setRemoteEnabled(true);
  }, [session.id]);

  useRepeatingClock(() => checkRemoteSyncRef.current(), REMOTE_SYNC_POLL_MS);

  useEffect(() => {
    let activeSync: SyncHandle | null = null;
    let starting = false;
    const checkSync = async () => {
      if (starting) return;
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
          } finally {
            starting = false;
          }
        }
      } else {
        if (activeSync) {
          activeSync.stop();
          activeSync = null;
        }
      }
    };

    checkRemoteSyncRef.current = () => void checkSync();

    const unsubscribeState = subscribeRemoteState(() => {
      void checkSync();
    });

    void checkSync();

    return () => {
      checkRemoteSyncRef.current = noop;
      unsubscribeState();
      if (activeSync) {
        activeSync.stop();
      }
    };
  }, [session, broker, pushRemoteQueued, runSubmittedTurnRef]);
}
