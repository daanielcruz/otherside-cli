import { HttpsProxyAgent } from "https-proxy-agent";
import { type ClientOptions, WebSocket as WsClient } from "ws";
import {
  type CodexRawLifecycleContext,
  nextCodexRawConnectionId,
  recordCodexRawLifecycle,
} from "@/devtools/codex-raw-stream.ts";
import {
  buildHeaders,
  RESPONSES_WS_URL,
  type SubAgentLabel,
} from "@/engine/providers/codex/fingerprint.ts";
import type { CodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

/**
 * Session-keyed reusable socket pool: connection identity, handshake, per-key
 * serialization, staleness-driven refresh, and disposal.
 */

export const CODEX_WS_CONNECTION_LIMIT_MS = 60 * 60 * 1000;
const CODEX_WS_REFRESH_SAFETY_MARGIN_MS = 60 * 1000;
export const CODEX_WS_REFRESH_AGE_MS =
  CODEX_WS_CONNECTION_LIMIT_MS - CODEX_WS_REFRESH_SAFETY_MARGIN_MS;

export const CODEX_WS_HANDSHAKE_TIMEOUT_MS = 30_000;

export function shouldRefreshCodexWsSocket(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs >= CODEX_WS_REFRESH_AGE_MS;
}

export class CodexWsHandshakeError extends Error {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CodexWsHandshakeError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface ReusableSocket {
  ws: WsClient;
  rawCaptureId: string;
  rawLifecycleContext: CodexRawLifecycleContext;
  consumer: ((data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void) | null;
  closeListeners: ((code: number, reason: string) => void)[];
  errorListeners: ((err: Error) => void)[];
  busy: boolean;
  createdAt: number;
  disposed?: boolean;
}

const SOCKETS = new Map<string, ReusableSocket>();

export function getSocketPoolForTest(): Map<string, ReusableSocket> {
  return SOCKETS;
}

export function getPooledSocket(key: string): ReusableSocket | undefined {
  return SOCKETS.get(key);
}

const LOCKS = new Map<string, Promise<void>>();

export function subagentFromCtx(ctx: RequestContext): {
  label: SubAgentLabel | undefined;
  parent: string | undefined;
  threadSource: "user" | "subagent";
} {
  const label = (ctx as RequestContext & { subagentLabel?: SubAgentLabel }).subagentLabel;
  if (!label) return { label: undefined, parent: undefined, threadSource: "user" };
  const parent = (ctx as RequestContext & { parentThreadId?: string }).parentThreadId;
  return { label, parent, threadSource: "subagent" };
}

let forkKeyCounter = 0;

export function socketKeyFor(ctx: RequestContext): string {
  const sub = (ctx as RequestContext & { subagentLabel?: string }).subagentLabel;
  if (sub) {
    forkKeyCounter = (forkKeyCounter + 1) | 0;
    return `${ctx.sessionId}::${sub}::${Date.now().toString(36)}_${forkKeyCounter.toString(36)}`;
  }
  return `${ctx.sessionId}::main`;
}

function rawLifecycleContextFor(
  ctx: RequestContext,
  connectionId: string,
  socketKey: string,
): CodexRawLifecycleContext {
  return {
    connectionId,
    sessionId: ctx.sessionId,
    socketKey,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.agentOwnerId ? { agentOwnerId: ctx.agentOwnerId } : {}),
    ...(ctx.parentThreadId ? { parentThreadId: ctx.parentThreadId } : {}),
    ...(ctx.subagentLabel ? { subagentLabel: ctx.subagentLabel } : {}),
    ...(ctx.isForkChild !== undefined ? { isForkChild: ctx.isForkChild } : {}),
    ...(ctx.requestRole ? { requestRole: ctx.requestRole } : {}),
  };
}

export async function acquireLock(key: string): Promise<() => void> {
  while (LOCKS.has(key)) {
    await LOCKS.get(key);
  }
  let release!: () => void;
  const p = new Promise<void>((resolve) => {
    release = () => {
      LOCKS.delete(key);
      resolve();
    };
  });
  LOCKS.set(key, p);
  return release;
}

export function disposeSocket(key: string, sock: ReusableSocket): void {
  if (SOCKETS.get(key) === sock) {
    SOCKETS.delete(key);
  }
  if (!sock.disposed) {
    recordCodexRawLifecycle("socket_dispose", sock.rawLifecycleContext);
  }
  sock.disposed = true;
  try {
    sock.ws.close();
  } catch {}
}

export async function ensureSocket(
  key: string,
  ctx: RequestContext,
  requestMetadata: CodexRequestMetadata,
  bearer: string,
  accountId: string | undefined,
): Promise<ReusableSocket> {
  const existing = SOCKETS.get(key);
  if (existing && existing.ws.readyState === WsClient.OPEN) return existing;

  const headers = buildHeaders({
    bearer,
    accountId,
    requestMetadata,
    transport: "ws",
    model: ctx.model,
  });
  const wsHeaders: Record<string, string> = { Host: "chatgpt.com", ...headers };
  const wsOptions: ClientOptions = {
    headers: wsHeaders,
    handshakeTimeout: CODEX_WS_HANDSHAKE_TIMEOUT_MS,
    // The responses upgrade offers permessage-deflate; the ws lib negotiates it
    // and writes Sec-WebSocket-Extensions itself, so we never set that header here.
    perMessageDeflate: true,
  };
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxyUrl) wsOptions.agent = new HttpsProxyAgent(proxyUrl);
  const ws = new WsClient(RESPONSES_WS_URL, wsOptions);
  const rawCaptureId = nextCodexRawConnectionId();
  const rawLifecycleContext = rawLifecycleContextFor(ctx, rawCaptureId, key);

  const sock: ReusableSocket = {
    ws,
    rawCaptureId,
    rawLifecycleContext,
    consumer: null,
    closeListeners: [],
    errorListeners: [],
    busy: false,
    createdAt: Date.now(),
  };
  SOCKETS.set(key, sock);

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    sock.consumer?.(data, isBinary);
  });
  ws.on("close", (code: number, reason: Buffer) => {
    const reasonText = reason?.toString("utf8") ?? "";
    recordCodexRawLifecycle("socket_close", {
      ...sock.rawLifecycleContext,
      code,
      reason: reasonText,
    });
    if (sock.disposed) return;
    if (SOCKETS.get(key) === sock) {
      SOCKETS.delete(key);
    }
    for (const cb of sock.closeListeners.splice(0)) cb(code, reasonText);
  });
  ws.on("error", (socketErr: Error) => {
    recordCodexRawLifecycle("socket_error", {
      ...sock.rawLifecycleContext,
      reason: socketErr.message,
    });
    if (sock.disposed) return;
    if (SOCKETS.get(key) === sock) {
      SOCKETS.delete(key);
    }
    const err = new Error("codex ws stream: socket error", { cause: socketErr });
    for (const cb of sock.errorListeners.splice(0)) cb(err);
  });

  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const onOpen = (): void => {
      cleanup();
      recordCodexRawLifecycle("socket_open", sock.rawLifecycleContext);
      resolve();
    };
    const onErr = (err: Error): void => {
      cleanup();
      if (SOCKETS.get(key) === sock) {
        SOCKETS.delete(key);
      }
      reject(annotateHandshakeError(err));
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      if (SOCKETS.get(key) === sock) {
        SOCKETS.delete(key);
      }
      const reasonText = reason?.toString("utf8") ?? "";
      const suffix = reasonText.length > 0 ? `: ${reasonText}` : "";
      reject(new CodexWsHandshakeError(`codex ws closed during handshake (code ${code}${suffix})`));
    };
    const cleanup = (): void => {
      ws.off("open", onOpen);
      ws.off("error", onErr);
      ws.off("close", onClose);
      if (onAbort && ctx.abortSignal) {
        ctx.abortSignal.removeEventListener("abort", onAbort);
      }
    };

    if (ctx.abortSignal?.aborted) {
      if (SOCKETS.get(key) === sock) {
        SOCKETS.delete(key);
      }
      sock.disposed = true;
      ws.terminate();
      reject(ctx.abortSignal.reason ?? new Error("aborted"));
      return;
    }

    if (ctx.abortSignal) {
      onAbort = () => {
        cleanup();
        if (SOCKETS.get(key) === sock) {
          SOCKETS.delete(key);
        }
        sock.disposed = true;
        ws.terminate();
        reject(ctx.abortSignal!.reason ?? new Error("aborted"));
      };
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    ws.once("open", onOpen);
    ws.once("error", onErr);
    ws.once("close", onClose);
  });
  return sock;
}

const HANDSHAKE_FAIL_PATTERNS = [
  /Expected 101 status code/i,
  /Unexpected server response/i,
  /failed to upgrade/i,
];

function annotateHandshakeError(err: Error): Error {
  const msg = err.message ?? "";
  if (HANDSHAKE_FAIL_PATTERNS.some((p) => p.test(msg))) {
    return new CodexWsHandshakeError(msg, err);
  }
  return err;
}

export function closeAllSockets(): void {
  for (const [key, sock] of SOCKETS) {
    if (SOCKETS.get(key) === sock) {
      SOCKETS.delete(key);
    }
    if (!sock.disposed) {
      recordCodexRawLifecycle("socket_dispose", sock.rawLifecycleContext);
    }
    sock.disposed = true;
    try {
      sock.ws.close();
    } catch {}
  }
}
