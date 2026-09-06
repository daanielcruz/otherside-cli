import {
  codexRawReplayStreamNeedsPrewarm,
  nextCodexRawStreamId,
  recordCodexRawFrame,
  recordCodexRawLifecycle,
  recordCodexRawReplayDiagnostic,
  releaseCodexRawPrimaryReplayTurn,
  waitForCodexRawPrimaryReplayTurn,
} from "@/devtools/codex-raw-stream.ts";
import { currentTokens, ensureInstallationId } from "@/engine/providers/codex/auth.ts";
import { buildCodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import {
  createCodexStreamDeadline,
  throwIfCodexDeadlineTimedOut,
} from "@/engine/providers/codex/transport/deadline.ts";
import { createSocketLivenessProbe } from "@/engine/providers/codex/transport/liveness.ts";
import { getSessionState } from "@/engine/providers/codex/transport/state.ts";
import {
  CodexWsBackpressureController,
  type WsBackpressureController,
} from "@/engine/providers/codex/transport/ws-backpressure.ts";
import { buildWsFrame, sendWsJsonFrame } from "@/engine/providers/codex/transport/ws-frames.ts";
import {
  buildWsFrameRouter,
  CodexWsClosedBeforeCompletionError,
} from "@/engine/providers/codex/transport/ws-router.ts";
import {
  acquireLock,
  disposeSocket,
  ensureSocket,
  getPooledSocket,
  type ReusableSocket,
  shouldRefreshCodexWsSocket,
  socketKeyFor,
  subagentFromCtx,
} from "@/engine/providers/codex/transport/ws-socket-pool.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

/** One request/response stream multiplexed over the pooled session socket. */
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
    const existing = getPooledSocket(key);
    const stale =
      proactiveRefreshEnabled && existing
        ? shouldRefreshCodexWsSocket(existing.createdAt, Date.now())
        : false;
    if (existing && existing.ws.readyState === existing.ws.OPEN && !stale) {
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
  // The probe fails a dead socket in seconds; the frame deadline stays as the
  // silent-model backstop, so a pong never re-arms it.
  const liveness = createSocketLivenessProbe({ ping: () => sock.ws.ping() }, (err) => {
    error = err;
    closed = true;
    disposeSocket(key, sock);
    drain();
  });
  const onPong = (): void => liveness.pongReceived();
  sock.ws.on("pong", onPong);

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
    liveness.frameReceived();
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
    liveness.dispose();
    sock.ws.off("pong", onPong);
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
