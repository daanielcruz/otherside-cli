import { io, type Socket } from "socket.io-client";

import { cortexUrl } from "./cortex.ts";

export interface BroadcastFrame {
  event: string;
  payload: Record<string, unknown>;
}

export interface RealtimeChannel {
  send(frame: BroadcastFrame): void;
  onBroadcast: (frame: BroadcastFrame) => void;
  close(): void;
}

export interface SubscribeOptions {
  topic: string;
  accessToken?: string | (() => Promise<string>);
  onBroadcast?: (frame: BroadcastFrame) => void;
  onError?: (err: Error) => void;
  onReconnect?: () => void;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type Shared = {
  socket: Socket;
  token: string;
  refCount: number;
  rooms: Map<string, Set<(event: string, payload: Record<string, unknown>) => void>>;
};

let shared: Shared | null = null;

function ensureSocket(token: string | null): Shared {
  const key = token ?? "";
  if (shared?.token === key) return shared;
  if (shared) {
    try {
      shared.socket.disconnect();
    } catch {
      /* ignore */
    }
    shared = null;
  }
  const socket = io(cortexUrl(), {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: token ? { token } : {},
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: RECONNECT_BASE_MS,
    reconnectionDelayMax: RECONNECT_MAX_MS,
  });
  const rooms = new Map<string, Set<(event: string, payload: Record<string, unknown>) => void>>();
  socket.onAny((event: string, ...args: unknown[]) => {
    // Room-targeted server emits arrive as (event, payload) without room id;
    // handlers are registered per-room and we fan-out to all room listeners.
    const payload =
      args[0] && typeof args[0] === "object"
        ? (args[0] as Record<string, unknown>)
        : { value: args[0] };
    for (const listeners of rooms.values()) {
      for (const fn of listeners) fn(event, payload);
    }
  });
  shared = { socket, token: key, refCount: 0, rooms };
  return shared;
}

async function resolveToken(opts: SubscribeOptions): Promise<string | null> {
  if (typeof opts.accessToken === "function") return opts.accessToken();
  if (typeof opts.accessToken === "string" && opts.accessToken.length > 0) return opts.accessToken;
  // Pair rooms allow guest sockets (CLI pre-auth handshake).
  if (opts.topic.startsWith("pair:")) return null;
  throw new Error("socket join requires access token");
}

function emitAck<T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(15_000).emit(event, payload, (err: Error | null, res: T) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

/**
 * Subscribe to a cortex Socket.IO room. Topic is the room name without prefix tricks
 * (`user:{uid}:env`, `session:{id}:events`, `pair:{nonce}`).
 */
export function subscribeChannel(opts: SubscribeOptions): Promise<RealtimeChannel> {
  return (async () => {
    const token = await resolveToken(opts);
    const sh = ensureSocket(token);
    sh.refCount += 1;
    const room = opts.topic;

    const joinRes = (await emitAck<{ ok?: boolean; error?: string }>(sh.socket, "join", room)) as {
      ok?: boolean;
      error?: string;
    };
    if (!joinRes?.ok) {
      sh.refCount -= 1;
      throw new Error(`channel join failed: ${joinRes?.error ?? "unknown"}`);
    }

    const listeners = sh.rooms.get(room) ?? new Set();
    sh.rooms.set(room, listeners);

    const onEvent = (event: string, payload: Record<string, unknown>) => {
      if (event === "events.appended") {
        // Durable notify — kick history poll via reconnect hook (start.ts).
        opts.onReconnect?.();
        return;
      }
      // Skip internal socket.io events
      if (event.startsWith("connect") || event === "disconnect") return;
      channel.onBroadcast({ event, payload });
    };
    listeners.add(onEvent);

    const onReconnect = () => {
      void emitAck(sh.socket, "join", room)
        .then(() => opts.onReconnect?.())
        .catch((err) => opts.onError?.(err instanceof Error ? err : new Error(String(err))));
    };
    sh.socket.on("connect", onReconnect);

    const channel: RealtimeChannel = {
      onBroadcast: opts.onBroadcast ?? (() => {}),
      send(frame) {
        void emitAck(sh.socket, "broadcast", {
          room,
          event: frame.event,
          payload: frame.payload,
        }).catch((err) => opts.onError?.(err instanceof Error ? err : new Error(String(err))));
      },
      close() {
        listeners.delete(onEvent);
        if (listeners.size === 0) sh.rooms.delete(room);
        sh.socket.off("connect", onReconnect);
        void emitAck(sh.socket, "leave", room).catch(() => {});
        sh.refCount -= 1;
        if (sh.refCount <= 0) {
          try {
            sh.socket.disconnect();
          } catch {
            /* ignore */
          }
          if (shared === sh) shared = null;
        }
      },
    };
    return channel;
  })();
}

/** Refresh JWT on the shared socket without dropping rooms. */
export async function refreshSocketAuth(accessToken: string): Promise<boolean> {
  if (!shared) return false;
  shared.token = accessToken;
  shared.socket.auth = { token: accessToken };
  if (!shared.socket.connected) {
    shared.socket.connect();
    return true;
  }
  try {
    const res = (await emitAck<{ ok?: boolean }>(shared.socket, "auth.refresh", {
      token: accessToken,
    })) as { ok?: boolean };
    return !!res?.ok;
  } catch {
    return false;
  }
}
