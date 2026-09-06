import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { type WebSocket as WsClient } from "ws";
import { getSocketPoolForTest } from "../ws-socket-pool.ts";

describe("Codex WebSocket Pool", () => {
  it("identity-safe eviction does not evict successor socket", () => {
    const pool = getSocketPoolForTest();
    const key = "test-session-id::main";
    pool.clear();

    const ws1 = new EventEmitter() as unknown as WsClient;
    const ws2 = new EventEmitter() as unknown as WsClient;

    const sock1 = {
      ws: ws1,
      rawCaptureId: "connection-1",
      rawLifecycleContext: { connectionId: "connection-1", sessionId: "test-session-id" },
      consumer: null,
      closeListeners: [],
      errorListeners: [],
      busy: false,
      createdAt: Date.now(),
      disposed: false,
    };

    const sock2 = {
      ws: ws2,
      rawCaptureId: "connection-2",
      rawLifecycleContext: { connectionId: "connection-2", sessionId: "test-session-id" },
      consumer: null,
      closeListeners: [],
      errorListeners: [],
      busy: false,
      createdAt: Date.now(),
      disposed: false,
    };

    pool.set(key, sock1);

    const closeListener1 = () => {
      if (sock1.disposed) return;
      if (pool.get(key) === sock1) {
        pool.delete(key);
      }
    };
    ws1.on("close", closeListener1);

    if (pool.get(key) === sock1) {
      pool.delete(key);
    }
    sock1.disposed = true;

    pool.set(key, sock2);

    const closeListener2 = () => {
      if (sock2.disposed) return;
      if (pool.get(key) === sock2) {
        pool.delete(key);
      }
    };
    ws2.on("close", closeListener2);

    ws1.emit("close");

    expect(pool.get(key)).toBe(sock2);
  });
});
