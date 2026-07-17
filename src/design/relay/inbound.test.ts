import { describe, expect, test } from "bun:test";
import { encryptEvent, generateSessionKey } from "@/backend/shared/e2ee.ts";
import { type RatchetCacheEntry, ratchetKeyFor } from "@/backend/shared/session-crypto.ts";
import type { MethodTable } from "@/design/bridge/dispatch.ts";
import { createInboundState, handleRelayRow, type InboundDeps } from "@/design/relay/inbound.ts";
import type { RpcContext } from "@/design/types.ts";

const ENC = new TextEncoder();
const FRAME = JSON.stringify({ jsonrpc: "2.0", method: "noop", params: {} });

function makeHarness() {
  const sessionHash = crypto.randomUUID();
  const sessionKey = generateSessionKey();
  const senderId = crypto.randomUUID();
  const sealRatchet = new Map<string, RatchetCacheEntry>();
  let handled = 0;
  const methodTable: MethodTable = {
    has: (method) => method === "noop",
    get: (method) =>
      method === "noop"
        ? () => {
            handled += 1;
          }
        : undefined,
    names: () => ["noop"],
  };
  const deps: InboundDeps = {
    state: createInboundState(),
    sessionHash,
    sessionKey,
    selfDeviceId: "self-device",
    methodTable,
    ctx: { send: () => {} } as unknown as RpcContext,
    onAttach: () => {},
  };
  function sealedRow(counter: number): Record<string, unknown> {
    const ratchetKey = ratchetKeyFor(sealRatchet, sessionKey, senderId, counter);
    const envelope = encryptEvent({
      ratchetKey,
      sessionId: sessionHash,
      eventType: "design_delta",
      senderDeviceId: senderId,
      counter,
      plaintext: ENC.encode(FRAME),
    });
    return { type: "design_delta", sender_device_id: senderId, payload: envelope };
  }
  return { deps, sealedRow, handledCount: () => handled };
}

describe("design relay inbound dedupe", () => {
  test("a replayed counter is dropped", async () => {
    const { deps, sealedRow, handledCount } = makeHarness();
    const row = sealedRow(1);
    await handleRelayRow(row, deps);
    await handleRelayRow(row, deps);
    expect(handledCount()).toBe(1);
    expect(deps.state.processed.size).toBe(1);
  });

  test("the processed set stays bounded under sustained inbound traffic", async () => {
    const { deps, sealedRow, handledCount } = makeHarness();
    const total = 5100;
    for (let counter = 1; counter <= total; counter += 1) {
      await handleRelayRow(sealedRow(counter), deps);
    }
    expect(handledCount()).toBe(total);
    expect(deps.state.processed.size).toBe(5000);
    // Recent keys survive eviction, so the reorder window still dedupes.
    await handleRelayRow(sealedRow(total), deps);
    expect(handledCount()).toBe(total);
  });
});
