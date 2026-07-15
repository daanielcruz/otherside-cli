import { markReachable, markUnreachable } from "@/design/spawn-registry.ts";
import { cortexFetch } from "@/remote/_infra/cortex.ts";
import { loadFreshAuth } from "@/remote/backend/auth.ts";
import { encryptEvent } from "@/remote/crypto/e2ee.ts";
import {
  incrementCounter,
  type RatchetCacheEntry,
  ratchetKeyFor,
} from "@/remote/session/sync/crypto.ts";

const ENC = new TextEncoder();
export const RELAY_POST_TIMEOUT_MS = 15_000;

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

async function freshToken(): Promise<string> {
  const auth = await loadFreshAuth();
  if (!auth) throw new Error("design relay: auth unavailable");
  return auth.accessToken;
}

export function createOutbound(deps: OutboundDeps): RelayOutbound {
  let chain: Promise<void> = Promise.resolve();
  let consecutiveFailures = 0;
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

  const sendFrame = (plaintext: string): void => {
    enqueue(async () => {
      const counter = incrementCounter(deps.sessionHash);
      const ratchetKey = ratchetKeyFor(deps.ratchet, deps.sessionKey, deps.deviceId, counter);
      const envelope = encryptEvent({
        ratchetKey,
        sessionId: deps.sessionHash,
        eventType: "design_delta",
        senderDeviceId: deps.deviceId,
        counter,
        plaintext: ENC.encode(plaintext),
      });
      await cortexFetch(`/v1/sessions/${deps.sessionHash}/events`, {
        method: "POST",
        token: await freshToken(),
        body: {
          sender_device_id: deps.deviceId,
          events: [
            {
              type: "design_delta",
              payload: envelope,
              counter,
            },
          ],
        },
        idempotencyKey: crypto.randomUUID(),
        signal: AbortSignal.timeout(RELAY_POST_TIMEOUT_MS),
      });
    });
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
