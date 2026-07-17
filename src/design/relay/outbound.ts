import { loadFreshAuth } from "@/backend/shared/auth.ts";
import { cortexFetch } from "@/backend/shared/cortex.ts";
import { encryptEvent } from "@/backend/shared/e2ee.ts";
import {
  incrementCounter,
  type RatchetCacheEntry,
  ratchetKeyFor,
} from "@/backend/shared/session-crypto.ts";
import { markReachable, markUnreachable } from "@/design/spawn-registry.ts";

const ENC = new TextEncoder();
export const RELAY_POST_TIMEOUT_MS = 15_000;
export const RELAY_EVENT_BATCH_SIZE = 25;
export const RELAY_BATCH_INTERVAL_MS = 125;

/** Consecutive send failures before the spawn is flagged unreachable. */
const UNREACHABLE_FAILURE_THRESHOLD = 3;

export interface OutboundDeps {
  spawnId: string;
  sessionHash: string;
  userId: string;
  sessionKey: Uint8Array;
  deviceId: string;
  ratchet: Map<string, RatchetCacheEntry>;
}

export interface RelayOutbound {
  sendFrame: (plaintext: string) => void;
  postBootstrap: (cliPubB64: string) => Promise<void>;
}

interface RelayEvent {
  type: "design_delta";
  payload: ReturnType<typeof encryptEvent>;
  counter: number;
}

async function freshToken(): Promise<string> {
  const auth = await loadFreshAuth();
  if (!auth) throw new Error("design relay: auth unavailable");
  return auth.accessToken;
}

export function createRelayBatcher<T>(
  flush: (items: T[]) => void,
  batchSize = RELAY_EVENT_BATCH_SIZE,
  intervalMs = RELAY_BATCH_INTERVAL_MS,
): (item: T) => void {
  const pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null || pending.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush(pending.splice(0, batchSize));
      schedule();
    }, intervalMs);
  };
  return (item: T): void => {
    pending.push(item);
    schedule();
  };
}

export function createOutbound(deps: OutboundDeps): RelayOutbound {
  let chain: Promise<void> = Promise.resolve();
  let consecutiveFailures = 0;
  const postEvents = async (events: RelayEvent[]): Promise<void> => {
    await cortexFetch(`/v1/sessions/${deps.sessionHash}/events`, {
      method: "POST",
      token: await freshToken(),
      body: {
        sender_device_id: deps.deviceId,
        events,
      },
      idempotencyKey: crypto.randomUUID(),
      signal: AbortSignal.timeout(RELAY_POST_TIMEOUT_MS),
    });
  };
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).then(
      () => {
        consecutiveFailures = 0;
        markReachable(deps.spawnId);
      },
      (err) => {
        process.stderr.write(
          `design relay: outbound failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        consecutiveFailures += 1;
        if (consecutiveFailures >= UNREACHABLE_FAILURE_THRESHOLD) {
          markUnreachable(deps.spawnId, err instanceof Error ? err.message : String(err));
        }
      },
    );
  };
  const pushEvent = createRelayBatcher<RelayEvent>((events) => {
    enqueue(() => postEvents(events));
  });

  const sendFrame = (plaintext: string): void => {
    const counter = incrementCounter(deps.sessionHash);
    const ratchetKey = ratchetKeyFor(deps.ratchet, deps.sessionKey, deps.deviceId, counter);
    const payload = encryptEvent({
      ratchetKey,
      sessionId: deps.sessionHash,
      eventType: "design_delta",
      senderDeviceId: deps.deviceId,
      counter,
      plaintext: ENC.encode(plaintext),
    });
    pushEvent({ type: "design_delta", payload, counter });
  };

  const postBootstrap = async (cliPubB64: string): Promise<void> => {
    await cortexFetch(`/v1/sessions/${deps.sessionHash}/events`, {
      method: "POST",
      token: await freshToken(),
      body: {
        sender_device_id: deps.deviceId,
        events: [
          {
            type: "design_hello",
            payload: { cli_device_id: deps.deviceId, cli_pub: cliPubB64 },
            counter: 0,
          },
        ],
      },
      idempotencyKey: crypto.randomUUID(),
      signal: AbortSignal.timeout(RELAY_POST_TIMEOUT_MS),
    });
  };

  return { sendFrame, postBootstrap };
}
