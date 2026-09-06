import { afterEach, describe, expect, test } from "bun:test";
import type { Device } from "@/backend/shared/device.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { type IncomingSyncState, syncIncomingEvents } from "../rails/durable.ts";

const originalFetch = globalThis.fetch;

function setFetchMock(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

function incomingState(): IncomingSyncState {
  return {
    cursorTs: null,
    processed: new Set(),
    ratchet: new Map(),
    watermark: new Map(),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("incoming session synchronization", () => {
  test("reports an automatically absent session as recoverable", async () => {
    setFetchMock(async () =>
      Response.json(
        {
          status: "error",
          error_code: "not_found",
          message: "session not found",
          request_id: "request-1",
        },
        { status: 404 },
      ),
    );

    const result = await syncIncomingEvents({
      device: { id: "device-1" } as unknown as Device,
      session: { id: "session-1" } as Session,
      accessToken: "access-token",
      sessionKey: new Uint8Array(32),
      broker: { dispatch: () => {} } as unknown as Broker,
      state: incomingState(),
    });

    expect(result).toBe(404);
  });

  test("reports a manual deletion as terminal", async () => {
    setFetchMock(async () =>
      Response.json(
        {
          status: "error",
          error_code: "session_deleted",
          message: "session deleted",
          request_id: "request-1",
        },
        { status: 410 },
      ),
    );

    const result = await syncIncomingEvents({
      device: { id: "device-1" } as unknown as Device,
      session: { id: "session-1" } as Session,
      accessToken: "access-token",
      sessionKey: new Uint8Array(32),
      broker: { dispatch: () => {} } as unknown as Broker,
      state: incomingState(),
    });

    expect(result).toBe(410);
  });
});
