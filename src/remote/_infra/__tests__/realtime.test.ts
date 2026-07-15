import { afterAll, describe, expect, mock, test } from "bun:test";

const realSocketIo = await import("socket.io-client");

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  auth: Record<string, unknown> = {};
  connectCalls = 0;
  disconnectCalls = 0;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  onAny(): this {
    return this;
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  timeout(): { emit: (event: string, payload: unknown, ack: Listener) => void } {
    return {
      emit: (event, payload, ack) => {
        this.emitted.push({ event, payload });
        ack(null, { ok: true });
      },
    };
  }

  disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  connect(): this {
    this.connectCalls += 1;
    this.connected = true;
    for (const listener of this.listeners.get("connect") ?? []) listener();
    return this;
  }
}

const sockets: FakeSocket[] = [];
mock.module("socket.io-client", () => ({
  io: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
}));

const { refreshSocketAuth, subscribeChannel } = await import("../realtime.ts");

afterAll(() => {
  mock.module("socket.io-client", () => realSocketIo);
});

describe("shared realtime authentication refresh", () => {
  test("reconnects the same socket and rejoins every room", async () => {
    expect(await refreshSocketAuth("unused")).toBe(false);

    let firstReconnects = 0;
    let secondReconnects = 0;
    const first = await subscribeChannel({
      topic: "session:first:events",
      accessToken: "token-a",
      onReconnect: () => {
        firstReconnects += 1;
      },
    });
    const second = await subscribeChannel({
      topic: "session:second:events",
      accessToken: "token-a",
      onReconnect: () => {
        secondReconnects += 1;
      },
    });

    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("missing fake socket");
    socket.connected = false;

    expect(await refreshSocketAuth("token-b")).toBe(true);
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(socket.connectCalls).toBe(1);
    expect(socket.auth).toEqual({ token: "token-b" });
    expect(firstReconnects).toBe(1);
    expect(secondReconnects).toBe(1);
    const joinedRooms = socket.emitted
      .filter(({ event }) => event === "join")
      .map(({ payload }) => payload);
    expect(joinedRooms).toEqual([
      "session:first:events",
      "session:second:events",
      "session:first:events",
      "session:second:events",
    ]);

    first.close();
    second.close();
  });
});
