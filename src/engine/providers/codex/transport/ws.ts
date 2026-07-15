import { createHash } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { type ClientOptions, WebSocket as WsClient } from "ws";
import {
  type CodexRawFrameContext,
  type CodexRawLifecycleContext,
  codexRawReplayStreamNeedsPrewarm,
  nextCodexRawConnectionId,
  nextCodexRawOutboundFrame,
  nextCodexRawStreamId,
  recordCodexRawFrame,
  recordCodexRawLifecycle,
  recordCodexRawReplayDiagnostic,
  releaseCodexRawPrimaryReplayTurn,
  waitForCodexRawPrimaryReplayTurn,
} from "@/devtools/codex-raw-stream.ts";
import { currentTokens, ensureInstallationId } from "@/engine/providers/codex/auth.ts";
import {
  buildHeaders,
  RESPONSES_WS_URL,
  type SubAgentLabel,
} from "@/engine/providers/codex/fingerprint.ts";
import {
  buildCodexRequestMetadata,
  type CodexRequestMetadata,
} from "@/engine/providers/codex/metadata.ts";
import {
  createCodexStreamDeadline,
  throwIfCodexDeadlineTimedOut,
} from "@/engine/providers/codex/transport/deadline.ts";
import { getSessionState } from "@/engine/providers/codex/transport/state.ts";
import {
  buildWsFrameRouter,
  CodexWsClosedBeforeCompletionError,
} from "@/engine/providers/codex/transport/ws-router.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export type { FrameRouterState } from "@/engine/providers/codex/transport/ws-router.ts";
export {
  buildWsFrameRouter,
  CodexWsClosedBeforeCompletionError,
  CodexWsConnectionLimitError,
  isCodexWsConnectionLimitCode,
  isCodexWsConnectionLimitMessage,
  TERMINAL_EVENTS,
  WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE,
  WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE,
} from "@/engine/providers/codex/transport/ws-router.ts";

export const CODEX_WS_CONNECTION_LIMIT_MS = 60 * 60 * 1000;
const CODEX_WS_REFRESH_SAFETY_MARGIN_MS = 60 * 1000;
export const CODEX_WS_REFRESH_AGE_MS =
  CODEX_WS_CONNECTION_LIMIT_MS - CODEX_WS_REFRESH_SAFETY_MARGIN_MS;

export const CODEX_WS_HANDSHAKE_TIMEOUT_MS = 30_000;

const CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES = 4 * 1024 * 1024;
const CODEX_WS_SEND_DRAIN_TIMEOUT_MS = 5_000;
const CODEX_WS_SEND_DRAIN_POLL_MS = 20;

export const CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK = 256;
export const CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK = 64;

export interface WsBackpressureController {
  sync(queueLength: number): void;
  dispose(): void;
}

export class CodexWsBackpressureController implements WsBackpressureController {
  private paused = false;
  constructor(private socket: Pick<WsClient, "pause" | "resume">) {}

  sync(queueLength: number): void {
    if (!this.paused && queueLength >= CODEX_WS_RECEIVE_QUEUE_HIGH_WATERMARK) {
      this.socket.pause();
      this.paused = true;
    } else if (this.paused && queueLength <= CODEX_WS_RECEIVE_QUEUE_LOW_WATERMARK) {
      this.socket.resume();
      this.paused = false;
    }
  }

  dispose(): void {
    if (this.paused) {
      try {
        this.socket.resume();
      } catch {}
      this.paused = false;
    }
  }
}

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

interface ReusableSocket {
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
const LOCKS = new Map<string, Promise<void>>();

function subagentFromCtx(ctx: RequestContext): {
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

function socketKeyFor(ctx: RequestContext): string {
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

async function acquireLock(key: string): Promise<() => void> {
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

function disposeSocket(key: string, sock: ReusableSocket): void {
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

async function ensureSocket(
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
  });
  const wsHeaders: Record<string, string> = { Host: "chatgpt.com", ...headers };
  const wsOptions: ClientOptions = {
    headers: wsHeaders,
    handshakeTimeout: CODEX_WS_HANDSHAKE_TIMEOUT_MS,
    // The ws lib enables permessage-deflate by default, allocating a native zlib
    // context per connection that inflates resident memory and is slow to reclaim.
    // We don't need wire compression here, so disable it.
    perMessageDeflate: false,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWsSendDrain(ws: WsClient): Promise<void> {
  const startedAt = Date.now();
  while (ws.bufferedAmount > CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES) {
    if (ws.readyState !== WsClient.OPEN) {
      throw new Error("codex ws send buffer could not drain because the socket closed");
    }
    if (Date.now() - startedAt >= CODEX_WS_SEND_DRAIN_TIMEOUT_MS) {
      throw new Error(
        `codex ws send buffer remained above ${CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES} bytes for ${CODEX_WS_SEND_DRAIN_TIMEOUT_MS}ms`,
      );
    }
    await delay(CODEX_WS_SEND_DRAIN_POLL_MS);
  }
}

function pendingWsSendDrain(ws: WsClient): Promise<void> | null {
  if (ws.bufferedAmount <= CODEX_WS_SEND_BUFFERED_AMOUNT_LIMIT_BYTES) return null;
  return waitForWsSendDrain(ws);
}

function sendWsJsonFrame(
  ws: WsClient,
  frame: Record<string, unknown>,
  captureContext: Omit<CodexRawFrameContext, "isBinary">,
): Promise<void> | null {
  const generatedPayload = JSON.stringify(frame);
  const replayFrame = nextCodexRawOutboundFrame({
    sessionId: captureContext.sessionId,
    streamId: captureContext.streamId,
    ...(captureContext.agentId ? { agentId: captureContext.agentId } : {}),
    ...(captureContext.requestRole ? { requestRole: captureContext.requestRole } : {}),
  });
  if (replayFrame) {
    const generatedBytes = Buffer.from(generatedPayload, "utf8");
    recordCodexRawReplayDiagnostic({
      event: "outbound_substitution",
      liveStreamId: captureContext.streamId,
      capturedStreamId: replayFrame.capturedStreamId,
      ...(captureContext.agentId ? { agentId: captureContext.agentId } : {}),
      generatedBytes: generatedBytes.length,
      replayBytes: replayFrame.payload.length,
      generatedSha256: createHash("sha256").update(generatedBytes).digest("hex"),
      replaySha256: createHash("sha256").update(replayFrame.payload).digest("hex"),
      byteEqual: replayFrame.payload.equals(generatedBytes),
    });
  }
  const payload = replayFrame?.payload ?? generatedPayload;
  const isBinary = replayFrame?.isBinary ?? false;
  const send = (): void => {
    recordCodexRawFrame(payload, { ...captureContext, isBinary });
    if (replayFrame) ws.send(replayFrame.payload, { binary: replayFrame.isBinary });
    else ws.send(generatedPayload);
  };
  const drain = pendingWsSendDrain(ws);
  if (!drain) {
    send();
    return null;
  }
  return drain.then(send);
}

export function buildWsFrame(
  body: unknown,
  requestMetadata: CodexRequestMetadata,
): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const frame: Record<string, unknown> = { type: "response.create" };
  if (src.model !== undefined) frame.model = src.model;
  if (src.instructions !== undefined) frame.instructions = src.instructions;
  if (src.input !== undefined) frame.input = src.input;
  if (src.tools !== undefined) frame.tools = src.tools;
  if (src.tool_choice !== undefined) frame.tool_choice = src.tool_choice;
  if (src.parallel_tool_calls !== undefined) frame.parallel_tool_calls = src.parallel_tool_calls;
  frame.reasoning = src.reasoning ?? null;
  if (src.store !== undefined) frame.store = src.store;
  if (src.stream !== undefined) frame.stream = src.stream;
  frame.include = src.include ?? [];
  if (src.service_tier !== undefined) frame.service_tier = src.service_tier;
  if (src.prompt_cache_key !== undefined) frame.prompt_cache_key = src.prompt_cache_key;
  if (src.text !== undefined) frame.text = src.text;
  frame.client_metadata = requestMetadata.clientMetadata;
  return frame;
}

export async function* streamWs(ctx: RequestContext, body: unknown): AsyncIterable<Uint8Array> {
  const rawStreamId = nextCodexRawStreamId();
  const tokens = await currentTokens();
  const ids = await ensureInstallationId();
  const session = getSessionState(ctx.sessionId);
  const sub = subagentFromCtx(ctx);
  const turnMetadata = buildCodexRequestMetadata({
    ctx,
    installationId: ids.installationId,
    mainSessionId: session.conversationId,
    mainThreadId: session.threadId,
    windowGeneration: session.windowGeneration,
    requestKind: "turn",
  });
  const rawReplayContext = {
    sessionId: ctx.sessionId,
    streamId: rawStreamId,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.requestRole ? { requestRole: ctx.requestRole } : {}),
  };
  recordCodexRawReplayDiagnostic({
    event: "stream_ws_enter",
    liveStreamId: rawStreamId,
    sessionId: ctx.sessionId,
    model: ctx.model,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(ctx.responseRequestId ? { responseRequestId: ctx.responseRequestId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.subagentLabel ? { subagentLabel: ctx.subagentLabel } : {}),
    ...(ctx.requestRole ? { requestRole: ctx.requestRole } : {}),
    ...(ctx.cacheRole ? { cacheRole: ctx.cacheRole } : {}),
    ...(ctx.agentic !== undefined ? { agentic: ctx.agentic } : {}),
    ...(ctx.disableThinking !== undefined ? { disableThinking: ctx.disableThinking } : {}),
    ...(ctx.isForkChild !== undefined ? { isForkChild: ctx.isForkChild } : {}),
  });
  await waitForCodexRawPrimaryReplayTurn(rawReplayContext);
  const replayNeedsPrewarm = codexRawReplayStreamNeedsPrewarm(rawReplayContext);
  const prewarmEnabled = process.env.OTHERSIDE_CODEX_PREWARM !== "0";
  const isMainUserTurn = sub.threadSource === "user";
  const shouldPrewarm =
    replayNeedsPrewarm ?? (prewarmEnabled && isMainUserTurn && !session.prewarmed);
  const prewarmMetadata = shouldPrewarm
    ? buildCodexRequestMetadata({
        ctx,
        installationId: ids.installationId,
        mainSessionId: session.conversationId,
        mainThreadId: session.threadId,
        windowGeneration: session.windowGeneration,
        requestKind: "prewarm",
      })
    : null;

  const key = socketKeyFor(ctx);
  const release = await acquireLock(key);

  if (ctx.abortSignal?.aborted) {
    release();
    releaseCodexRawPrimaryReplayTurn(rawReplayContext);
    throw ctx.abortSignal.reason ?? new Error("aborted");
  }

  const queue: Uint8Array[] = [];
  let closed = false;
  let sawTerminal = false;
  let sawErrorTerminal = false;
  let aborted = false;
  let error: Error | null = null;
  let resolveNext: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let abortListenerInstalled = false;

  let backpressure: WsBackpressureController = {
    sync: () => {},
    dispose: () => {},
  };

  const drain = (): void => {
    if (!resolveNext) return;
    if (queue.length > 0) {
      const v = queue.shift();
      if (v) {
        resolveNext({ value: v, done: false });
        resolveNext = null;
        backpressure.sync(queue.length);
      }
    } else if (error) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined as unknown as Uint8Array, done: true });
    } else if (closed) {
      resolveNext({ value: undefined as unknown as Uint8Array, done: true });
      resolveNext = null;
    }
  };

  const onClose = (code: number, reason: string): void => {
    if (aborted) {
      closed = true;
      drain();
      return;
    }
    if (error) {
      closed = true;
      drain();
      return;
    }
    if (!sawTerminal) {
      error = new CodexWsClosedBeforeCompletionError(code, reason);
    }
    closed = true;
    drain();
  };
  const onError = (err: Error): void => {
    if (!error) error = err;
    drain();
  };

  const prewarmResponseIds = new Set<string>();
  const handleFrame = buildWsFrameRouter({
    queue,
    drain,
    setSawTerminal: (v) => {
      sawTerminal = v;
    },
    setSawErrorTerminal: (v) => {
      sawErrorTerminal = v;
    },
    setClosed: (v) => {
      closed = v;
    },
    setError: (err) => {
      error = err;
    },
    session,
    prewarmIds: prewarmResponseIds,
  });

  const proactiveRefreshEnabled = process.env.OTHERSIDE_CODEX_WS_PROACTIVE_REFRESH === "1";

  let sock: ReusableSocket;
  try {
    const existing = SOCKETS.get(key);
    const stale =
      proactiveRefreshEnabled && existing
        ? shouldRefreshCodexWsSocket(existing.createdAt, Date.now())
        : false;
    if (existing && existing.ws.readyState === WsClient.OPEN && !stale) {
      sock = existing;
    } else {
      if (existing) disposeSocket(key, existing);
      sock = await ensureSocket(
        key,
        ctx,
        prewarmMetadata ?? turnMetadata,
        `Bearer ${tokens.accessToken}`,
        tokens.accountId,
      );
    }
    backpressure = new CodexWsBackpressureController(sock.ws);
  } catch (err) {
    release();
    releaseCodexRawPrimaryReplayTurn(rawReplayContext);
    throw err;
  }

  const deadline = createCodexStreamDeadline(ctx.abortSignal, (err) => {
    error = err;
    closed = true;
    disposeSocket(key, sock);
    drain();
  });

  const requestId = ctx.responseRequestId ?? ctx.agentId ?? ctx.turnId;
  const rawCaptureContext = {
    connectionId: sock.rawCaptureId,
    streamId: rawStreamId,
    sessionId: ctx.sessionId,
    ...(requestId ? { requestId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.subagentLabel ? { subagentLabel: ctx.subagentLabel } : {}),
    ...(ctx.isForkChild !== undefined ? { isForkChild: ctx.isForkChild } : {}),
    ...(ctx.requestRole ? { requestRole: ctx.requestRole } : {}),
  };
  const rawStreamLifecycleContext = {
    ...sock.rawLifecycleContext,
    streamId: rawStreamId,
    ...(requestId ? { requestId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  };
  recordCodexRawLifecycle("stream_start", rawStreamLifecycleContext);
  sock.closeListeners.push(onClose);
  sock.errorListeners.push(onError);
  sock.consumer = (data, isBinary) => {
    recordCodexRawFrame(data, { ...rawCaptureContext, direction: "inbound", isBinary });
    deadline.arm();
    handleFrame(data);
    backpressure.sync(queue.length);
  };

  const abortStream = (): void => {
    aborted = true;
    closed = true;
    disposeSocket(key, sock);
    drain();
  };

  if (ctx.abortSignal?.aborted) {
    abortStream();
  } else if (ctx.abortSignal) {
    ctx.abortSignal.addEventListener("abort", abortStream, { once: true });
    abortListenerInstalled = true;
  }

  try {
    const src = (body ?? {}) as Record<string, unknown>;

    if (prewarmMetadata) {
      const prewarmFrame: Record<string, unknown> = { type: "response.create" };
      if (src.model !== undefined) prewarmFrame.model = src.model;
      if (src.instructions !== undefined) prewarmFrame.instructions = src.instructions;
      if (src.tools !== undefined) prewarmFrame.tools = src.tools;
      prewarmFrame.generate = false;
      prewarmFrame.input = [];
      if (src.prompt_cache_key !== undefined) prewarmFrame.prompt_cache_key = src.prompt_cache_key;
      prewarmFrame.client_metadata = prewarmMetadata.clientMetadata;
      const prewarmSend = sendWsJsonFrame(sock.ws, prewarmFrame, {
        ...rawCaptureContext,
        direction: "outbound",
      });
      if (prewarmSend) await prewarmSend;
      session.prewarmed = true;
    }

    const wrapped = buildWsFrame(body, turnMetadata);
    const wrappedSend = sendWsJsonFrame(sock.ws, wrapped, {
      ...rawCaptureContext,
      direction: "outbound",
    });
    if (wrappedSend) await wrappedSend;

    while (true) {
      if (queue.length > 0) {
        const v = queue.shift();
        if (v) {
          backpressure.sync(queue.length);
          yield v;
        }
        continue;
      }
      if (error) throw error;
      if (closed) return;
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
        resolveNext = resolve;
      });
      if (next.done) {
        if (error) throw error;
        return;
      }
      yield next.value;
    }
  } catch (err) {
    throwIfCodexDeadlineTimedOut(deadline);
    throw err;
  } finally {
    backpressure.dispose();
    deadline.dispose();
    if (abortListenerInstalled && ctx.abortSignal) {
      ctx.abortSignal.removeEventListener("abort", abortStream);
    }
    sock.consumer = null;
    const closeIdx = sock.closeListeners.indexOf(onClose);
    if (closeIdx >= 0) sock.closeListeners.splice(closeIdx, 1);
    const errIdx = sock.errorListeners.indexOf(onError);
    if (errIdx >= 0) sock.errorListeners.splice(errIdx, 1);
    const streamEndReason = aborted
      ? "aborted"
      : sawErrorTerminal || error
        ? "error"
        : sawTerminal
          ? "complete"
          : "incomplete";
    recordCodexRawLifecycle("stream_end", {
      ...rawStreamLifecycleContext,
      reason: streamEndReason,
    });
    const isSubagentSocket = sub.threadSource === "subagent";
    // sawErrorTerminal: the backend reported a failure on this socket; retries
    // must reconnect fresh instead of reusing the possibly-broken session.
    if (!sawTerminal || sawErrorTerminal || isSubagentSocket) disposeSocket(key, sock);
    release();
    releaseCodexRawPrimaryReplayTurn(rawReplayContext);
  }
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
