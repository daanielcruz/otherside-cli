import { randomUUID } from "node:crypto";
import { ProviderHttpError, streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import {
  INTERRUPT_MESSAGE,
  isInterruptionMessage,
} from "@/engine/queue/runtime/interruption-text.ts";
import {
  classifyProviderError,
  type RetryDecisionDetailed,
} from "@/engine/transport/_infra/classify/classify.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  CloudClient,
  type CloudClientOptions,
  type CloudCursor,
  type CloudEvent,
  CloudIdentityChangedError,
  encodeCloudEvent,
  record,
  string,
} from "./client.ts";
import { buildCloudHistorySnapshot } from "./history.ts";
import {
  CLOUD_BOUNDARY_HOOK_ID,
  CLOUD_CONNECT_TOOL,
  CLOUD_CONNECT_TOOL_NAME,
  CLOUD_LOCAL_TOOL_BACKGROUND_ENV,
  CLOUD_LOCAL_TOOL_TIMEOUT_MS,
  type CloudTool,
  cancelledMcpRequestId,
  cloudPermissionResponse,
  denyCloudHook,
  isBackgroundedMcpResult,
  isRegisteredCloudTool,
  MCP_SERVER_NAME,
  MCP_TOOL_PREFIX,
  mcpHandshake,
  mcpToolResult,
  nativeDenyUpdate,
  normalizeNativeToolName,
  type PendingToolCall,
  parseToolCall,
  verifyLocalToolWait,
  verifyNativeDenies,
} from "./mcp.ts";
import {
  CloudRequest,
  CloudSyntheticAssistantError,
  cloudAssistantRefusal,
  cloudSyntheticAssistantError,
  cloudUserContent,
  resultError,
  translateRequestCloud,
  translateResponseCloud,
} from "./translate.ts";

export interface CloudAdapterOptions extends CloudClientOptions {
  environmentId?: string | ((ctx: RequestContext) => Promise<string>) | undefined;
  controlTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
}

type EventReader = AsyncGenerator<CloudEvent | null>;
type Usage = Record<string, number>;
type SnapshotReason =
  | "history"
  | "system-change"
  | "compaction"
  | "interruption"
  | "local-rejection"
  | "idle-worker"
  | DetachedSession["reason"];

interface DetachedSession {
  reason: "contention" | "local-call-abandoned" | "session-interrupted";
  error: CloudCallbackContentionError | CloudLocalCallAbandonedError | CloudSessionInterruptedError;
  messages: readonly Message[];
}

export class CloudSessionInterruptedError extends Error {
  constructor(cause: string, options?: ErrorOptions) {
    super(
      `The Cloud session stopped unexpectedly (${cause}). Send a new message to continue in a new protected session from the local history; completed actions are not repeated.`,
      options,
    );
    this.name = "CloudSessionInterruptedError";
  }
}

// Only explicit policy/account/isolation failures latch permanently. Transport and worker
// availability failures retire the worker through the same audited detachment path as contention.
class CloudSessionSafetyError extends Error {}

class CloudSyntheticRefusalError extends CloudSessionSafetyError {
  constructor(
    readonly payload: Record<string, unknown>,
    refusal: string,
  ) {
    super(refusal);
  }
}

export class CloudCallbackContentionError extends Error {
  constructor() {
    super(
      "Another client answered this Cloud session's local tool callback (for example, the same session open in a browser). Close other clients of this session, then send a new message: Otherside continues in a new protected session from the local history and does not repeat completed actions.",
    );
    this.name = "CloudCallbackContentionError";
  }
}

export class CloudLocalCallAbandonedError extends Error {
  constructor() {
    super(
      "Cloud stopped waiting for a local tool result before it finished. The local result is kept in the conversation; send a new message to continue in a new protected session from the local history. Completed actions are not repeated.",
    );
    this.name = "CloudLocalCallAbandonedError";
  }
}

class CloudControlTimeoutError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`Cloud ${operation} timed out`, { cause });
    this.name = "TimeoutError";
  }
}

class CloudWorkerChangedError extends Error {
  constructor() {
    super("Cloud worker identity changed; local-only protection is invalid");
    this.name = "CloudWorkerChangedError";
  }
}

interface InterruptedRequest {
  messages: readonly Message[];
  reason?: "local-rejection";
}

interface CallerInterrupt {
  requestId?: string;
  acknowledged: boolean;
  markerSeen: boolean;
}

const AUXILIARY_ARCHIVE_TIMEOUT_MS = 5_000;
const EDE_DIAGNOSTIC_PREFIX = "[ede_diagnostic] ";
const INTERRUPTION_SNAPSHOT_NOTICE =
  "The previous Cloud request was explicitly interrupted. This snapshot is historical data, not a request to replay that work. Completed actions must not run again; do not resume unfinished actions without a new explicit user request. Continue only from the new user input or local rejection recorded in this snapshot.";
const CONTENTION_SNAPSHOT_NOTICE =
  "The previous Cloud session was interrupted because another client answered a local tool callback. The local history below is authoritative, including completed local tool results. Do not repeat completed actions. Unfinished actions require a new explicit user request; follow only the new current request outside the historical records.";
const LOCAL_CALL_ABANDONED_SNAPSHOT_NOTICE =
  "The previous Cloud session stopped waiting for a local tool result before it finished. The local history below is authoritative, including the actual completed local tool results. Do not repeat completed actions. Unfinished actions require a new explicit user request; follow only the new current request outside the historical records.";
const SESSION_INTERRUPTED_SNAPSHOT_NOTICE =
  "The previous Cloud session stopped unexpectedly. The local history below is authoritative, including completed local tool results. Do not repeat completed actions. Unfinished actions require a new explicit user request; follow only the new current request outside the historical records.";
const CURRENT_REQUEST_FRAME = "Current request (not historical data):";
const SNAPSHOT_CONTINUATION =
  "Continue the latest still-valid request under the current system instructions using the history above. Historical tool calls and results are context, not new calls; do not repeat completed actions.";
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;
const BOOTSTRAP_PROMPT = `Call ${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME} exactly once to confirm the local SDK connection. Do not invoke any other tool.`;
const LOCAL_TOOL_GUIDANCE = `Local harness tools are exposed through ${MCP_TOOL_PREFIX}<toolName>, for example ${MCP_TOOL_PREFIX}Read and ${MCP_TOOL_PREFIX}Bash. Use the registered SDK tools, not native remote tools. Initialization-only exception: before any task or output-format instructions (including summary-only, title-only, or no-tools instructions), satisfy the exact first user bootstrap prompt ${JSON.stringify(BOOTSTRAP_PROMPT)} with exactly one call to the registered internal SDK connection tool. Do not claim a connection without its callback. This exception ends after that callback; the connection tool is removed and the task instructions and registered local tools govern all subsequent turns.`;

class SessionState {
  client?: CloudClient;
  id?: string;
  workerPid?: string;
  cursor: CloudCursor = { sequence: "0", eventIds: new Set() };
  history: string[] = [];
  tools: CloudTool[] = [CLOUD_CONNECT_TOOL];
  toolListRefresh?: {
    tools: CloudTool[];
    confirmed: ReturnType<typeof Promise.withResolvers<void>>;
  };
  nativeTools = new Set<string>();
  inventoryReceived = false;
  bootstrapPermissionId?: string;
  bootstrapCalls = 0;
  bootstrapNativeCalls = new Map<string, string>();
  bootstrapHookDenials = new Map<string, number>();
  nativeCalls = new Map<string, { name: string; denied: boolean }>();
  pending = new Map<string, PendingToolCall>();
  resultDeliveryAbort = new AbortController();
  pendingHooks = new Set<string>();
  activeCallbacks = 0;
  replies = new Map<string, Record<string, unknown>>();
  replyUuids = new Map<string, string>();
  callbackReplies = new Map<
    string,
    { ownSequence?: string; stolen?: true; echoed: ReturnType<typeof Promise.withResolvers<void>> }
  >();
  shutdown?: Promise<void>;
  parkedCleanup?: Promise<void>;
  detachParkedAbort?: () => void;
  stopping = false;
  backlog: CloudEvent[] = [];
  events = new AsyncStream<CloudEvent | null>();
  connection?: EventConnection;
  usage = new Map<string, Usage>();
  contextMessageId?: string;
  contextTokens?: number | null;
  bootstrapUsage: Usage = {};
  accountedUsage: Usage = {};
  busy = false;
  attemptSignal?: AbortSignal;
  ready = false;
  verified = false;
  activeTurn = false;
  failure?: Error;
  detached?: DetachedSession;
  latestRequestMessages: readonly Message[];
  interrupted?: InterruptedRequest;
  callerInterrupt?: CallerInterrupt;
  pendingCaller?: { signal: AbortSignal; messages: readonly Message[] };
  stopConfirmed = false;
  compactionPending = false;
  effort: string;
  thinkingDisplay?: CloudRequest["thinkingDisplay"];

  constructor(
    readonly request: CloudRequest,
    readonly snapshotReason?: SnapshotReason,
  ) {
    this.effort = request.effort;
    this.latestRequestMessages = request.messages;
  }
}

export function cloudSessionKey(ctx: RequestContext): string {
  return JSON.stringify([
    ctx.sessionId,
    ctx.agentId,
    ctx.agentOwnerId,
    ctx.requestRole,
    ctx.subagentLabel,
    ctx.cacheRole,
    ctx.isCompaction === true,
    ctx.agentic === false,
  ]);
}

export function createAnthropicCloudAdapter(options: CloudAdapterOptions) {
  const client = new CloudClient(options);
  const sessions = new Map<string, SessionState>();
  const readers = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const requests = new WeakMap<CloudRequest, { key: string; generation: number }>();

  function translateRequest(
    ctx: RequestContext,
    messages: Message[],
    tools: unknown[],
  ): CloudRequest {
    const request = translateRequestCloud(ctx, messages, tools);
    if (request.tools.some((tool) => tool.name === CLOUD_CONNECT_TOOL_NAME)) {
      throw new Error(`Cloud local tool name is reserved: ${CLOUD_CONNECT_TOOL_NAME}`);
    }
    const key = cloudSessionKey(ctx);
    requests.set(request, { key, generation: generations.get(key) ?? 0 });
    return request;
  }

  function recoverableError(
    error: unknown,
    ctx: RequestContext,
    attempt = 1,
  ): RetryDecisionDetailed {
    const state = sessions.get(cloudSessionKey(ctx));
    const context = { attempt, provider: ctx.provider, model: ctx.model };
    const terminal = state?.failure ?? terminalSessionFailure(error);
    if (terminal) {
      const diagnostic = classifyProviderError(terminal, context);
      const failed = diagnostic.kind === "fail" ? diagnostic : undefined;
      const userMessage =
        terminal instanceof CloudSessionSafetyError ||
        terminal instanceof CloudSyntheticAssistantError
          ? terminal.message
          : (failed?.userMessage ?? terminal.message);
      return {
        ...failed,
        kind: "fail",
        reason: terminal.message,
        failure: diagnostic.failure,
        userMessage,
      };
    }
    if (error instanceof ProviderHttpError && error.status === 401)
      return classifyProviderError(error, context);
    const detached = state?.detached?.error ?? (isDetachedSessionError(error) ? error : undefined);
    if (detached) {
      const diagnostic = classifyProviderError(detached.cause ?? error, context);
      return {
        ...(diagnostic.kind === "fail" && diagnostic.status !== undefined ? diagnostic : {}),
        kind: "fail",
        reason: detached.message,
        failure: diagnostic.failure,
        userMessage:
          detached.cause instanceof CloudSyntheticAssistantError
            ? `${detached.cause.message}\n${detached.message}`
            : detached.message,
      };
    }
    const decision = classifyProviderError(error, context);
    if (decision.kind === "fail")
      return {
        ...decision,
        userMessage: decision.userMessage ?? decision.message ?? decision.reason,
      };
    // Only a discarded pre-creation state proves no model input or callback was delivered.
    // A live, latched, or interrupted worker must never be retried by replaying the failed attempt.
    const cannotRetry =
      state?.id ||
      state?.failure ||
      state?.interrupted ||
      state?.attemptSignal?.aborted ||
      state?.pendingCaller?.signal.aborted;
    if (!cannotRetry) return decision;
    return {
      kind: "fail",
      reason: decision.reason,
      failure: decision.failure,
      userMessage: decision.message ?? decision.reason,
      ...(decision.status !== undefined ? { status: decision.status } : {}),
      ...(decision.message !== undefined ? { message: decision.message } : {}),
    };
  }

  async function acquireReader(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const previous = readers.get(key) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    // A cancelled waiter still follows its predecessor: later readers cannot bypass the active one.
    const tail = previous.then(() => done.promise);
    readers.set(key, tail);
    const release = () => {
      done.resolve();
      void tail.then(() => {
        if (readers.get(key) === tail) readers.delete(key);
      });
    };
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  async function* stream(
    ctx: RequestContext,
    body: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const release = await acquireReader(cloudSessionKey(ctx), signal);
    try {
      // Resolve state and validate generation after waiting: the prior reader may have retired it.
      yield* streamSession(ctx, body, signal);
    } finally {
      release();
    }
  }

  async function* streamSession(
    ctx: RequestContext,
    body: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (!(body instanceof CloudRequest))
      throw new Error("Cloud stream requires translateRequest output");
    if (body.cwd !== ctx.cwd)
      throw new Error(
        "Cloud request working directory differs from the active context; translate the request again",
      );
    signal.throwIfAborted();
    const key = cloudSessionKey(ctx);
    const ephemeral = ctx.agentic === false;
    const stamp = requests.get(body);
    if (!stamp || stamp.key !== key || stamp.generation !== (generations.get(key) ?? 0)) {
      throw new Error("Cloud request belongs to another session or predates compaction");
    }
    const existing = sessions.get(key);
    let state =
      existing ??
      new SessionState(body, needsInitialSnapshot(body.messages) ? "history" : undefined);
    if (!existing) sessions.set(key, state);
    if (state.parkedCleanup) await abortable(state.parkedCleanup, signal);
    if (state.failure) throw state.failure;
    observePendingCancellation(state);
    if (state.failure) throw state.failure;
    let rotation = rotationReason(state, body);
    if (!rotation && state.pending.size > 0) {
      const results = new Set(
        body.messages
          .slice(state.history.length)
          .flatMap((message) =>
            message.content.flatMap((block) =>
              block.type === "tool_result" ? [block.tool_use_id] : [],
            ),
          ),
      );
      if ([...state.pending.keys()].some((id) => !results.has(id))) {
        // This reader is out of order, not a worker failure. Leave the parked bridge and owner intact.
        throw new CloudSessionInterruptedError("a local tool result is still pending");
      }
    }
    state.busy = true;
    let identityVerified = false;
    let authenticationExpired = false;
    let readerAbort = state.connection?.controller ?? new AbortController();
    let reader: EventReader | undefined;
    let deliveredRefusal: CloudSyntheticRefusalError | undefined;
    let handedOff = false;
    const interrupt = () => {
      if (!state.id || state.shutdown) return;
      if (
        !state.failure &&
        !state.detached &&
        isExplicitCancellation(signal, signal.reason, ctx.abortSignal)
      ) {
        // Record caller intent before posting: the worker can finish interruption before its receipt.
        state.callerInterrupt ??= { acknowledged: false, markerSeen: false };
      }
      beginShutdown(state);
    };
    try {
      state.client ??= await client.bindCurrentIdentity();
      await sessionClient(state).assertCurrentIdentity();
      identityVerified = true;
      signal.throwIfAborted();
      state.detachParkedAbort?.();
      delete state.detachParkedAbort;
      state.latestRequestMessages = body.messages;
      state.attemptSignal = signal;
      state.verified = false;
      signal.addEventListener("abort", interrupt, { once: true });
      if (state.id && !state.interrupted && !state.detached) {
        reader = await openEventReader(state, readerAbort, signal);
        if (!state.ready)
          throw new CloudSessionSafetyError("Cloud cannot resume an unverified worker");
        try {
          yield* verifyBoundary(state, reader, signal);
        } catch (error) {
          signal.throwIfAborted();
          const idleInitializeTimeout =
            error instanceof CloudControlTimeoutError && error.operation === "initialize";
          if (
            (!(error instanceof CloudWorkerChangedError) && !idleInitializeTimeout) ||
            !canReplaceIdleWorker(state, body)
          )
            throw error;
          if (idleInitializeTimeout) {
            assertHistoryPrefix(state, body);
            latchSessionFailure(state, error);
          }
          rotation ??= "idle-worker";
        }
        if (rotation) assertNativeDenialsConfirmed(state);
        if (state.failure) throw state.failure;
      }
      if (rotation) {
        if (state.id) {
          try {
            await beginShutdown(state);
          } catch (error) {
            latchSessionFailure(state, error);
            if (state.failure) throw state.failure;
            // A transport failure delivering interrupt does not prove execution stopped. The
            // durable audit and successful archive below are still mandatory before replacement.
          }
          readerAbort.abort();
          await closeEventReader(state, reader);
          reader = undefined;
          // Shutdown can deliver a terminal worker result before its POST receipt. Never rotate past it.
          if (state.failure) throw state.failure;
          if (state.detached) await drainDetachedHistory(state, signal);
          if (state.failure) throw state.failure;
          await sessionClient(state).archiveSession(state.id, signal);
        }
        signal.throwIfAborted();
        if (state.failure) throw state.failure;
        const replacement = new SessionState(body, rotation);
        // Retain the bound identity across rotations; a new login never inherits this transcript.
        replacement.client = sessionClient(state);
        replacement.busy = true;
        replacement.attemptSignal = signal;
        state.busy = false;
        state = replacement;
        sessions.set(key, state);
        generations.set(key, (generations.get(key) ?? 0) + 1);
        readerAbort = new AbortController();
      }
      if (!state.id) {
        const preferredId =
          typeof options.environmentId === "function"
            ? await options.environmentId(ctx)
            : options.environmentId;
        const environmentId = await sessionClient(state).resolveEnvironment(preferredId, signal);
        const title = ctx.requestRole ?? ctx.subagentLabel ?? (ephemeral ? "auxiliary" : "session");
        state.id = await sessionClient(state).createSession({
          title: `Otherside ${title}`,
          environmentId: string(environmentId, "environmentId"),
          model: body.model,
          effort: body.effort,
          signal,
        });
        signal.throwIfAborted();
        reader = await openEventReader(state, readerAbort, signal);
        yield* prepareSession(state, reader, signal);
        yield* verifyBoundary(state, reader, signal);
      }
      if (!reader) throw new Error("Cloud session has no verified event reader");
      yield* updateEffort(state, body.effort, reader, signal);
      yield* updateThinkingDisplay(state, body.thinkingDisplay, reader, signal);
      yield* updateTools(state, body.tools, reader, signal);
      await submitNewMessages(state, body, signal);
      while (true) {
        const queued = state.backlog.shift();
        const next = queued ? { done: false, value: queued } : await abortableNext(reader, signal);
        if (next.done)
          throw new Error("Cloud stream ended without a result or local tool callback");
        const event = next.value;
        if (!event) {
          yield encodeCloudEvent(null);
          continue;
        }
        if (observeInventory(state, event)) continue;
        if (event.payload.type === "control_request") {
          const call = await handleControl(state, event.payload, signal);
          if (!call) continue;
          if (ephemeral)
            throw new Error("Cloud received a local tool callback for a non-agentic request");
          if (state.pending.has(call.toolUseId))
            throw new Error("Cloud repeated an outstanding tool-use ID");
          state.pending.set(call.toolUseId, call);
          const usage = roundUsage(state);
          state.accountedUsage = totalUsageWithBootstrap(state);
          handedOff = true;
          yield encodeCloudEvent(
            localCallEvent(event, call, { usage, contextTokens: state.contextTokens }),
          );
          return;
        }
        if (event.payload.type === "assistant") {
          validateAssistant(event.payload, state);
          yield encodeCloudEvent(normalizeUsage(state, event));
          continue;
        }
        if (event.payload.type === "user") {
          observeNativeDenialResults(state, event.payload);
          continue;
        }
        if (event.payload.type === "result") {
          assertNativeDenialsConfirmed(state);
          state.activeTurn = false;
          if (event.payload.is_error === true || event.payload.subtype !== "success") {
            latchSessionFailure(state, workerFailure(event.payload, state));
            if (!state.failure) throw state.detached?.error;
          }
          yield encodeCloudEvent(normalizeUsage(state, event));
          return;
        }
        if (event.payload.type === "error") {
          latchSessionFailure(state, workerFailure(event.payload, state));
          if (!state.failure) throw state.detached?.error;
          interrupt();
          yield encodeCloudEvent(event);
          return;
        }
      }
    } catch (error) {
      if (
        !identityVerified &&
        !state.failure &&
        error instanceof ProviderHttpError &&
        error.status === 401
      ) {
        authenticationExpired = true;
        if (!state.id && sessions.get(key) === state) sessions.delete(key);
        throw error;
      }
      state.detachParkedAbort?.();
      delete state.detachParkedAbort;
      state.latestRequestMessages = body.messages;
      if (
        !state.failure &&
        !state.detached &&
        isExplicitCancellation(signal, error, ctx.abortSignal)
      ) {
        state.interrupted = { messages: body.messages };
      } else {
        latchSessionFailure(state, error, !!rotation);
      }
      if (state.detached && rotation) state.detached.messages = body.messages;
      // No id means no prompt or callback could have been delivered. A clean retry is safe.
      if (!state.id) {
        if (sessions.get(key) === state) sessions.delete(key);
        throw error;
      }
      // Never use a newly logged-in account to interrupt or resume another account's worker.
      if (!(state.failure instanceof CloudIdentityChangedError)) interrupt();
      if (state.failure instanceof CloudSyntheticRefusalError) {
        deliveredRefusal = state.failure;
        yield encodeCloudEvent({ event_type: "message", payload: deliveredRefusal.payload });
        return;
      }
      throw state.failure ?? state.detached?.error ?? error;
    } finally {
      signal.removeEventListener("abort", interrupt);
      if (authenticationExpired) {
        state.busy = false;
      } else {
        try {
          await completeShutdown(state, state.shutdown).catch((error: unknown) => {
            if (!deliveredRefusal || error !== deliveredRefusal) throw error;
          });
        } finally {
          try {
            const keepConnected =
              !ephemeral && handedOff && !signal.aborted && !state.failure && !state.stopping;
            if (!keepConnected) {
              readerAbort.abort();
              await closeEventReader(state, reader);
              state.verified = false;
            }
            state.busy = false;
            delete state.attemptSignal;
            if (keepConnected) {
              watchParkedCancellation(state, body.messages, ctx.abortSignal ?? signal);
            } else {
              delete state.pendingCaller;
            }
            if (
              !state.failure &&
              !state.detached &&
              isExplicitCancellation(signal, signal.reason, ctx.abortSignal)
            ) {
              state.interrupted = { messages: body.messages };
            }
          } finally {
            if (ephemeral) await retireAuxiliarySession(key, state);
          }
        }
      }
    }
  }

  async function retireAuxiliarySession(key: string, state: SessionState): Promise<void> {
    if (sessions.get(key) === state) sessions.delete(key);
    if (!state.id) return;
    const signal = AbortSignal.timeout(AUXILIARY_ARCHIVE_TIMEOUT_MS);
    try {
      await abortable(sessionClient(state).archiveSession(state.id, signal), signal);
    } catch {
      // Cleanup must not replace a response already delivered, and writing to the terminal
      // here would corrupt the rendered frame. The Cloud session stays listed until archived.
    }
  }

  async function drainDetachedHistory(
    state: SessionState,
    callerSignal: AbortSignal,
  ): Promise<void> {
    const complete = new Error("Cloud detached session history drain completed");
    const stop = new AbortController();
    const deadline = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(options.controlTimeoutMs ?? 30_000),
    ]);
    const signal = AbortSignal.any([deadline, stop.signal]);
    let drained = false;
    // Reuse the existing paginated catch-up transport. onOpen is reached only after every durable
    // page is drained; stop at that boundary without handling callbacks or resuming the worker.
    const events = sessionClient(state).events(
      string(state.id, "session.id"),
      state.cursor,
      signal,
      {
        onOpen: () => {
          drained = true;
          stop.abort(complete);
        },
        onReconnect: () => {
          throw new Error("Cloud detached session history drain lost its event connection");
        },
      },
    );
    try {
      for (const event of state.backlog.splice(0)) inspectDetachedWorkerEvent(state, event.payload);
      for await (const event of state.events.iterate(() => true)) {
        if (event) inspectDetachedWorkerEvent(state, event.payload);
      }
      try {
        for await (const event of events) {
          if (drained) break;
          if (event && event.source !== "client") inspectDetachedWorkerEvent(state, event.payload);
        }
      } catch (error) {
        if (!drained || error !== complete) throw error;
      }
      deadline.throwIfAborted();
      if (!drained) throw new Error("Cloud detached session history drain ended before completion");
      assertNativeDenialsConfirmed(state);
      if (state.bootstrapNativeCalls.size > 0)
        throw new CloudSessionSafetyError(
          "Cloud detached session left native bootstrap denials unconfirmed",
        );
      if (state.failure) throw state.failure;
    } catch (error) {
      latchSessionFailure(state, error);
      throw state.failure ?? error;
    } finally {
      stop.abort();
      await events.return(undefined);
    }
  }

  async function openEventReader(
    state: SessionState,
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<EventReader> {
    state.connection ??= connectEvents(state, controller, {
      onFailure: (error) => {
        if (error instanceof CloudIdentityChangedError) controller.abort();
        else beginShutdown(state);
        if (!state.busy) cleanParkedSession(state);
      },
      handleCallback: async (payload) => {
        state.activeCallbacks++;
        try {
          await sessionClient(state).assertCurrentIdentity();
          await handleControl(state, payload, controller.signal);
        } finally {
          state.activeCallbacks--;
        }
      },
      onResult: () => {
        if (!state.busy && (state.failure || state.detached)) {
          beginShutdown(state);
          cleanParkedSession(state);
        }
      },
    });
    await abortable(
      state.connection.ready,
      AbortSignal.any([signal, AbortSignal.timeout(options.controlTimeoutMs ?? 30_000)]),
    );
    state.connection.assertOpen();
    return state.connection.reader;
  }

  async function* prepareSession(
    state: SessionState,
    reader: EventReader,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const initialized = yield* control(state, {
      request: {
        subtype: "initialize",
        hooks: { PreToolUse: [{ hookCallbackIds: [CLOUD_BOUNDARY_HOOK_ID] }] },
        systemPrompt: [state.request.systemPrompt, localToolGuidance(state.request.cwd)].filter(
          Boolean,
        ),
      },
      reader,
      signal,
    });
    if (initialized.hooks_applied !== true)
      throw new CloudSessionSafetyError("Cloud did not install the local-only PreToolUse hook");
    state.workerPid = workerPid(initialized);
    yield* control(state, {
      request: {
        subtype: "apply_flag_settings",
        settings: { env: { [CLOUD_LOCAL_TOOL_BACKGROUND_ENV]: "0" } },
      },
      reader,
      signal,
    });
    const settings = yield* control(state, {
      request: { subtype: "get_settings" },
      reader,
      signal,
    });
    verifyLocalToolWait(settings);
    yield* updateThinkingDisplay(state, state.request.thinkingDisplay, reader, signal);
    const registration = yield* control(state, {
      request: {
        subtype: "mcp_set_servers",
        servers: {
          [MCP_SERVER_NAME]: {
            type: "sdk",
            name: MCP_SERVER_NAME,
            timeout: CLOUD_LOCAL_TOOL_TIMEOUT_MS,
          },
        },
      },
      reader,
      signal,
    });
    const errors = record(registration.errors, "mcp_set_servers errors");
    if (Object.keys(errors).length > 0)
      throw new Error(`Cloud MCP registration failed: ${JSON.stringify(errors)}`);
    const bootstrapSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.bootstrapTimeoutMs ?? 120_000),
    ]);
    state.activeTurn = true;
    await postUser(state, BOOTSTRAP_PROMPT, bootstrapSignal);
    while (true) {
      const next = await abortableNext(reader, bootstrapSignal);
      if (next.done)
        throw new Error("Cloud bootstrap ended before confirming its local connection");
      const event = next.value;
      if (!event) {
        yield encodeCloudEvent(null);
        continue;
      }
      if (observeInventory(state, event)) continue;
      const payload = event.payload;
      if (payload.type === "control_request") {
        await handleControl(state, payload, bootstrapSignal);
        continue;
      }
      if (payload.type === "assistant") {
        validateAssistant(payload, state);
        normalizeUsage(state, event);
        continue;
      }
      if (payload.type === "user") {
        observeBootstrapToolResults(state, payload);
        continue;
      }
      if (payload.type === "result") {
        state.activeTurn = false;
        if (payload.is_error === true || payload.subtype !== "success")
          throw new Error(resultError(payload));
        if (state.bootstrapNativeCalls.size > 0)
          throw new CloudSessionSafetyError(
            "Cloud bootstrap did not confirm native tool denial results",
          );
        if (state.failure) throw state.failure;
        if (!state.bootstrapPermissionId) {
          throw new Error(
            "Cloud bootstrap did not confirm exactly one permitted local SDK connection: no connection can_use_tool callback was received",
          );
        }
        if (state.bootstrapCalls !== 1) {
          throw new Error(
            `Cloud bootstrap did not confirm exactly one permitted local SDK connection: received ${state.bootstrapCalls} connection tools/call callbacks after permission approval`,
          );
        }
        state.bootstrapUsage =
          state.usage.size > 0 ? totalUsage(state.usage) : readUsage(payload.usage ?? {});
        state.usage.clear();
        state.ready = true;
        return;
      }
      if (payload.type === "error") throw new Error(resultError(payload));
    }
  }

  async function* verifyBoundary(
    state: SessionState,
    reader: EventReader,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    state.verified = false;
    // Repeated initialize is read-only: never reapply hooks or system settings to a new worker.
    const initialized = yield* control(state, {
      request: { subtype: "initialize" },
      reader,
      signal,
    });
    if (state.failure) throw state.failure;
    if (workerPid(initialized) !== state.workerPid) throw new CloudWorkerChangedError();
    const permissions = yield* control(state, {
      request: { subtype: "list_permission_rules" },
      reader,
      signal,
    });
    assertIsolation(() => verifyNativeDenies(permissions, state.nativeTools));
    state.verified = true;
  }

  async function* updateEffort(
    state: SessionState,
    effort: string,
    reader: EventReader,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (state.effort === effort) return;
    // Flag settings merge at the top level, preserving the bootstrap env unless explicitly patched.
    yield* control(state, {
      request: { subtype: "apply_flag_settings", settings: { effortLevel: effort } },
      reader,
      signal,
    });
    const settings = yield* control(state, {
      request: { subtype: "get_settings" },
      reader,
      signal,
    });
    const applied = record(settings.applied, "get_settings applied");
    if (applied.effort !== effort || applied.model !== state.request.model) {
      throw new Error("Cloud did not confirm the requested effort/model in get_settings.applied");
    }
    verifyLocalToolWait(settings);
    yield* verifyBoundary(state, reader, signal);
    state.effort = effort;
  }

  async function* updateThinkingDisplay(
    state: SessionState,
    thinkingDisplay: CloudRequest["thinkingDisplay"],
    reader: EventReader,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (state.thinkingDisplay === thinkingDisplay) return;
    yield* control(state, {
      request: { subtype: "set_max_thinking_tokens", thinking_display: thinkingDisplay },
      reader,
      signal,
    });
    if (state.ready) yield* verifyBoundary(state, reader, signal);
    state.thinkingDisplay = thinkingDisplay;
  }

  async function* updateTools(
    state: SessionState,
    tools: CloudTool[],
    reader: EventReader,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (JSON.stringify(state.tools) === JSON.stringify(tools)) return;
    if (!state.verified)
      throw new CloudSessionSafetyError(
        "Cloud cannot publish local schemas before verifying its boundary",
      );
    state.tools = tools;
    // Arm before notifying: the worker may request the new list before acknowledging delivery.
    const refresh = { tools, confirmed: Promise.withResolvers<void>() };
    state.toolListRefresh = refresh;
    try {
      yield* control(state, {
        request: {
          subtype: "mcp_message",
          server_name: MCP_SERVER_NAME,
          message: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        },
        reader,
        signal,
      });
      const deadline = AbortSignal.timeout(options.controlTimeoutMs ?? 30_000);
      const waitSignal = AbortSignal.any([
        signal,
        deadline,
        state.connection?.controller.signal ?? signal,
      ]);
      try {
        await abortable(refresh.confirmed.promise, waitSignal);
      } catch (error) {
        if (state.failure) throw state.failure;
        if (state.detached) throw state.detached.error;
        if (
          deadline.aborted &&
          waitSignal.reason === deadline.reason &&
          error === deadline.reason
        ) {
          const timeout = new Error("Cloud worker did not refresh its local tool list", {
            cause: error,
          });
          timeout.name = "TimeoutError";
          throw timeout;
        }
        throw error;
      }
      assertEventConnection(state);
      if (state.failure) throw state.failure;
    } finally {
      if (state.toolListRefresh === refresh) delete state.toolListRefresh;
    }
  }

  async function* control(
    state: SessionState,
    input: {
      request: Record<string, unknown>;
      reader: EventReader;
      signal: AbortSignal;
    },
  ): AsyncGenerator<Uint8Array, Record<string, unknown>> {
    const payload = controlPayload(input.request);
    const deadline = AbortSignal.timeout(options.controlTimeoutMs ?? 30_000);
    const signal = AbortSignal.any([input.signal, deadline]);
    try {
      assertEventConnection(state);
      await sessionClient(state).postEvent(string(state.id, "session.id"), payload, signal);
      assertEventConnection(state);
      while (true) {
        const next = await abortableNext(input.reader, signal);
        if (next.done)
          throw new Error(
            `Cloud ${String(input.request.subtype)} control ended without a response`,
          );
        const event = next.value;
        if (!event) {
          yield encodeCloudEvent(null);
          continue;
        }
        if (observeInventory(state, event)) continue;
        if (event.payload.type === "control_response") {
          const response = record(event.payload.response, "control response");
          if (response.request_id !== payload.request_id) continue;
          if (response.subtype !== "success") {
            throw new Error(
              `Cloud ${String(input.request.subtype)} control failed: ${String(response.error ?? JSON.stringify(response))}`,
            );
          }
          return response.response === undefined
            ? {}
            : record(response.response, "control success response");
        }
        if (event.payload.type === "control_request") {
          const request = record(event.payload.request, "control request");
          const rpc =
            request.subtype === "mcp_message" ? record(request.message, "MCP message") : undefined;
          if (rpc?.method !== "tools/call") {
            await handleControl(state, event.payload, signal);
            continue;
          }
        }
        if (state.ready && event.payload.type === "user") {
          observeNativeDenialResults(state, event.payload);
          continue;
        }
        if (event.payload.type === "result") assertNativeDenialsConfirmed(state);
        if (
          event.payload.type === "error" ||
          (event.payload.type === "result" && event.payload.is_error === true)
        ) {
          throw new Error(resultError(event.payload));
        }
        if (event.payload.type === "assistant") validateAssistant(event.payload, state);
        if (["assistant", "result", "control_request"].includes(String(event.payload.type))) {
          if (!state.ready)
            throw new CloudSessionSafetyError(
              "Cloud began inference before installing the local boundary",
            );
          // Other parallel SDK calls can precede the control response on reopening. Do not lose them.
          state.backlog.push(event);
        }
      }
    } catch (error) {
      if (deadline.aborted && signal.reason === deadline.reason && error === deadline.reason) {
        throw new CloudControlTimeoutError(String(input.request.subtype), error);
      }
      throw error;
    }
  }

  async function handleControl(
    state: SessionState,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PendingToolCall | undefined> {
    assertEventConnection(state);
    const requestId = string(payload.request_id, "control request_id");
    const request = record(payload.request, "control request");
    if (state.callbackReplies.get(requestId)?.stolen) return;
    if (state.stopping || state.failure || state.detached) {
      if (request.subtype === "hook_callback") {
        await reply(state, requestId, denyCloudHook(), signal);
        state.pendingHooks.delete(requestId);
      } else if (request.subtype === "can_use_tool") {
        await reply(
          state,
          requestId,
          { behavior: "deny", message: "The local SDK session is stopping" },
          signal,
        );
      }
      return;
    }
    if (request.subtype === "hook_callback") {
      state.pendingHooks.add(requestId);
      const input = record(request.input, "hook input");
      const allowed = isRegisteredCloudTool(input.tool_name, state.tools);
      let response = allowed ? {} : denyCloudHook(input.tool_name, state.tools);
      if (
        !state.ready &&
        allowed &&
        input.tool_name === `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`
      ) {
        // The bootstrap permission callback must install session denies before any real task.
        response = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason:
              "Confirm the local SDK connection through its permission callback before continuing initialization.",
          },
        };
      }
      await reply(state, requestId, response, signal);
      state.pendingHooks.delete(requestId);
      if (!allowed) {
        if (canRecoverNativeDenial(state, input.tool_name)) return;
        if (state.ready || !state.activeTurn)
          throw new CloudSessionSafetyError(
            `Cloud requested a nonlocal hook: ${String(input.tool_name)}`,
          );
        const name = string(input.tool_name, "bootstrap hook tool_name");
        state.bootstrapHookDenials.set(name, (state.bootstrapHookDenials.get(name) ?? 0) + 1);
      }
      return;
    }
    const previous = state.replies.get(requestId);
    if (previous) {
      await sessionClient(state).postEvent(string(state.id, "session.id"), previous, signal);
      return;
    }
    if (request.subtype === "can_use_tool") {
      const response = cloudPermissionResponse(request, state.tools);
      if (!state.ready && response.behavior === "allow") {
        if (!state.inventoryReceived || state.bootstrapPermissionId) {
          await reply(
            state,
            requestId,
            { behavior: "deny", message: "Cloud bootstrap inventory or callback is invalid" },
            signal,
          );
          throw new CloudSessionSafetyError(
            "Cloud bootstrap requires an inventory and exactly one permission callback",
          );
        }
        state.bootstrapPermissionId = string(request.tool_use_id, "bootstrap tool_use_id");
        response.updatedPermissions = nativeDenyUpdate(state.nativeTools);
      }
      await reply(state, requestId, response, signal);
      if (response.behavior !== "allow" && !canRecoverNativeDenial(state, request.tool_name))
        throw new CloudSessionSafetyError(
          `Cloud requested a nonlocal tool permission: ${String(request.tool_name)}`,
        );
      return;
    }
    if (request.subtype !== "mcp_message") {
      throw new Error(`Cloud sent an unsupported control request: ${String(request.subtype)}`);
    }
    if (request.server_name !== MCP_SERVER_NAME)
      throw new CloudSessionSafetyError("Cloud requested a foreign MCP server");
    const rpc = record(request.message, "MCP message");
    // Cancellation was inspected by the raw pump; notifications have no tool result to answer.
    if (cancelledMcpRequestId(rpc) !== undefined) return;
    const tools = state.tools;
    const refresh = state.toolListRefresh;
    const response = mcpHandshake(rpc, tools);
    if (response) {
      await reply(state, requestId, { mcp_response: response }, signal);
      if (
        rpc.method === "tools/list" &&
        refresh?.tools === tools &&
        state.toolListRefresh === refresh &&
        !state.stopping &&
        state.callbackReplies.get(requestId)?.ownSequence
      ) {
        // reply has proved our response won; an older catalog or POST receipt cannot release user data.
        refresh.confirmed.resolve();
      }
      return;
    }
    const call = assertIsolation(() => parseToolCall(payload, state.tools));
    if (!state.ready) {
      if (call.name !== CLOUD_CONNECT_TOOL_NAME || call.toolUseId !== state.bootstrapPermissionId) {
        throw new CloudSessionSafetyError("Cloud bootstrap received an unpermitted SDK call");
      }
      if (state.bootstrapCalls !== 0)
        throw new Error("Cloud bootstrap received a duplicate connection tools/call callback");
      state.bootstrapCalls++;
      await reply(
        state,
        requestId,
        {
          mcp_response: mcpToolResult(call, {
            type: "tool_result",
            tool_use_id: call.toolUseId,
            content: "Local connection ready.",
          }),
        },
        signal,
      );
      return;
    }
    if (!state.verified)
      throw new CloudSessionSafetyError(
        "Cloud local SDK callback arrived before boundary revalidation",
      );
    if (state.failure) throw state.failure;
    await sessionClient(state).assertCurrentIdentity();
    assertEventConnection(state);
    return call;
  }

  async function reply(
    state: SessionState,
    requestId: string,
    response: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.callbackReplies.get(requestId)?.stolen)
      throw state.failure ?? state.detached?.error ?? new CloudCallbackContentionError();
    const payload = {
      type: "control_response",
      uuid: randomUUID(),
      response: { subtype: "success", request_id: requestId, response },
    };
    state.replies.set(requestId, payload);
    state.replyUuids.set(payload.uuid, requestId);
    await sessionClient(state).postEvent(string(state.id, "session.id"), payload, signal);
    const callback = state.callbackReplies.get(requestId);
    if (!state.stopping && callback && state.connection) {
      try {
        await abortable(
          callback.echoed.promise,
          AbortSignal.any([
            signal,
            state.connection.controller.signal,
            AbortSignal.timeout(options.controlTimeoutMs ?? 30_000),
          ]),
        );
      } catch (error) {
        throw state.failure ?? state.detached?.error ?? error;
      }
      if (state.failure) throw state.failure;
      if (state.detached) throw state.detached.error;
    }
  }

  function beginShutdown(state: SessionState): Promise<void> {
    if (state.shutdown) return state.shutdown;
    state.stopping = true;
    const controller = state.connection?.controller;
    state.shutdown = stopWorker(state).finally(() => controller?.abort());
    // Active consumers await this; parked sessions observe it through cleanParkedSession.
    void state.shutdown.catch(() => undefined);
    return state.shutdown;
  }

  function cleanParkedSession(state: SessionState): void {
    if (state.parkedCleanup) return;
    state.detachParkedAbort?.();
    delete state.detachParkedAbort;
    state.parkedCleanup = (async () => {
      try {
        await completeShutdown(state, state.shutdown);
      } finally {
        state.connection?.controller.abort();
        await closeEventReader(state, state.connection?.reader);
        state.verified = false;
      }
    })().catch((error: unknown) => {
      latchSessionFailure(state, error);
    });
  }

  function watchParkedCancellation(
    state: SessionState,
    messages: readonly Message[],
    signal: AbortSignal,
  ): void {
    state.pendingCaller = { signal, messages };
    const abort = () => {
      if (
        !state.failure &&
        !state.detached &&
        isExplicitCancellation(signal, signal.reason, signal)
      ) {
        state.interrupted = { messages };
        state.callerInterrupt ??= { acknowledged: false, markerSeen: false };
      } else {
        latchSessionFailure(state, signal.reason);
      }
      beginShutdown(state);
      cleanParkedSession(state);
    };
    signal.addEventListener("abort", abort, { once: true });
    state.detachParkedAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }

  async function stopWorker(state: SessionState): Promise<void> {
    if (state.stopConfirmed) return;
    const errors: unknown[] = [];
    for (const requestId of state.pendingHooks) {
      if (state.callbackReplies.get(requestId)?.stolen) {
        state.pendingHooks.delete(requestId);
        continue;
      }
      try {
        // Hook callback errors can fail open. Even during cancellation send an explicit deny.
        await reply(state, requestId, denyCloudHook(), AbortSignal.timeout(5_000));
        state.pendingHooks.delete(requestId);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      const interrupt = controlPayload({ subtype: "interrupt" });
      if (state.callerInterrupt)
        state.callerInterrupt.requestId = string(interrupt.request_id, "interrupt request_id");
      await sessionClient(state).postEvent(
        string(state.id, "session.id"),
        interrupt,
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        "Cloud could not confirm delivery of its deny/interrupt cleanup",
      );
    state.stopConfirmed = true;
  }

  async function submitNewMessages(
    state: SessionState,
    request: CloudRequest,
    signal: AbortSignal,
  ): Promise<void> {
    assertEventConnection(state);
    if (!state.verified)
      throw new CloudSessionSafetyError("Cloud local-only boundary was not revalidated");
    if (state.failure) throw state.failure;
    const history = request.messages.map(messageIdentity);
    if (state.history.length === 0 && state.snapshotReason) {
      const content = snapshotRequestContent(request);
      if (state.snapshotReason === "interruption" || state.snapshotReason === "local-rejection") {
        content.unshift({ type: "text", text: INTERRUPTION_SNAPSHOT_NOTICE });
      }
      if (state.snapshotReason === "contention")
        content.unshift({ type: "text", text: CONTENTION_SNAPSHOT_NOTICE });
      if (state.snapshotReason === "local-call-abandoned")
        content.unshift({ type: "text", text: LOCAL_CALL_ABANDONED_SNAPSHOT_NOTICE });
      if (state.snapshotReason === "session-interrupted")
        content.unshift({ type: "text", text: SESSION_INTERRUPTED_SNAPSHOT_NOTICE });
      // Historical tool_result blocks belong to the snapshot, never to an old pending SDK RPC.
      state.usage.clear();
      resetContextTokens(state);
      state.accountedUsage = {};
      state.history = history;
      state.activeTurn = true;
      await postUser(state, content, signal);
      return;
    }
    assertHistoryPrefix(state, request);
    const fresh = request.messages.slice(state.history.length);
    const results = fresh.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result"),
    );
    const userBlocks = fresh
      .filter((message) => message.role === "user")
      .flatMap((message) => {
        return message.content.filter((block) => block.type !== "tool_result");
      });
    if (userBlocks.length > 0 && (state.pending.size > 0 || state.activeTurn)) {
      throw new Error("Cloud cannot submit a new user turn while its previous turn is active");
    }
    for (const result of results) {
      assertEventConnection(state);
      const pending = state.pending.get(result.tool_use_id);
      if (!pending)
        throw new Error(`Cloud has no pending SDK call for tool result ${result.tool_use_id}`);
      await reply(
        state,
        pending.requestId,
        { mcp_response: mcpToolResult(pending, result) },
        AbortSignal.any([signal, state.resultDeliveryAbort.signal]),
      );
      state.pending.delete(result.tool_use_id);
    }
    if (userBlocks.length > 0) {
      assertNativeDenialsConfirmed(state);
      state.nativeCalls.clear();
      if (state.history.length > 0) state.bootstrapUsage = {};
      state.usage.clear();
      resetContextTokens(state);
      state.accountedUsage = {};
      state.activeTurn = true;
      const content = cloudUserContent(userBlocks);
      state.history = history;
      await postUser(state, content, signal);
      return;
    }
    state.history = history;
    if (!state.activeTurn)
      throw new Error("Cloud request contains no new user message or pending turn");
  }

  async function postUser(
    state: SessionState,
    content: string | Record<string, unknown>[],
    signal: AbortSignal,
  ): Promise<void> {
    assertEventConnection(state);
    await sessionClient(state).postEvent(
      string(state.id, "session.id"),
      {
        type: "user",
        uuid: randomUUID(),
        session_id: state.id,
        parent_tool_use_id: null,
        message: { role: "user", content },
      },
      signal,
    );
  }

  async function onToolTurnStopped(ctx: RequestContext): Promise<void> {
    if (sessions.get(cloudSessionKey(ctx))?.busy)
      throw new Error("Cannot stop a Cloud tool turn while its reader is consuming a round");
    const release = await acquireReader(cloudSessionKey(ctx), new AbortController().signal);
    try {
      await stopToolTurn(ctx);
    } finally {
      release();
    }
  }

  async function stopToolTurn(ctx: RequestContext): Promise<void> {
    const state = sessions.get(cloudSessionKey(ctx));
    if (!state || state.pending.size === 0) return;
    if (state.busy)
      throw new Error("Cannot stop a Cloud tool turn while its reader is consuming a round");
    state.busy = true;
    state.stopping = true;
    state.detachParkedAbort?.();
    delete state.detachParkedAbort;
    try {
      await sessionClient(state).assertCurrentIdentity();
      if (!state.failure) {
        state.interrupted = {
          messages:
            state.interrupted?.messages ?? state.pendingCaller?.messages ?? state.request.messages,
          reason: "local-rejection",
        };
        state.callerInterrupt ??= { acknowledged: false, markerSeen: false };
      }
      // The rejected local result is already persisted by the harness. Do not send it as an RPC
      // result: that would let the worker continue a turn the user explicitly stopped.
      await completeShutdown(state, beginShutdown(state));
    } catch (error) {
      latchSessionFailure(state, error);
    } finally {
      state.connection?.controller.abort();
      await closeEventReader(state, state.connection?.reader);
      state.busy = false;
      state.verified = false;
      delete state.pendingCaller;
    }
    if (state.failure || state.detached) {
      delete state.interrupted;
      throw state.failure ?? state.detached?.error;
    }
  }

  function onCompactionSucceeded(ctx: RequestContext): void {
    // The harness reports success with the main context, but the summarizer used isCompaction.
    const keys = new Set([cloudSessionKey(ctx), cloudSessionKey({ ...ctx, isCompaction: true })]);
    const states = [...keys].map((key) => sessions.get(key));
    if (states.some((state) => state?.busy)) {
      throw new Error("Cannot replace an active Cloud reader during compaction");
    }
    if (states.some((state) => state?.failure)) return;
    for (const key of keys) {
      const state = sessions.get(key);
      if (state) state.compactionPending = true;
      generations.set(key, (generations.get(key) ?? 0) + 1);
    }
  }

  return {
    translateRequest,
    stream,
    translateResponse: translateResponseCloud,
    recoverableError,
    onToolTurnStopped,
    onCompactionSucceeded,
  };
}

function isDetachedSessionError(error: unknown): error is DetachedSession["error"] {
  return (
    error instanceof CloudCallbackContentionError ||
    error instanceof CloudLocalCallAbandonedError ||
    error instanceof CloudSessionInterruptedError
  );
}

function terminalSessionFailure(error: unknown): Error | undefined {
  if (error instanceof CloudIdentityChangedError || error instanceof CloudSessionSafetyError)
    return error;
  if (error instanceof ProviderHttpError && isPolicyOrIsolationFailure(error.body)) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const terminal = terminalSessionFailure(nested);
      if (terminal) return terminal;
    }
  }
  return undefined;
}

function assertIsolation<T>(verify: () => T): T {
  try {
    return verify();
  } catch (error) {
    throw new CloudSessionSafetyError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

function latchSessionFailure(state: SessionState, error: unknown, recovering = false): void {
  const terminal = terminalSessionFailure(error);
  if (terminal) {
    state.failure ??= terminal;
    state.resultDeliveryAbort.abort(state.failure);
    return;
  }
  const detached = isDetachedSessionError(error)
    ? error
    : new CloudSessionInterruptedError(
        (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160),
        { cause: error },
      );
  if (!state.detached || recovering) {
    state.detached = {
      reason:
        detached instanceof CloudCallbackContentionError
          ? "contention"
          : detached instanceof CloudLocalCallAbandonedError
            ? "local-call-abandoned"
            : "session-interrupted",
      error: detached,
      messages: state.latestRequestMessages,
    };
  }
  // Cancel even a prepared POST awaiting credentials, without stopping the shutdown audit reader.
  state.resultDeliveryAbort.abort(state.failure ?? state.detached.error);
  if (!state.failure) state.callerInterrupt ??= { acknowledged: false, markerSeen: false };
}

function abandonedLocalCall(state: SessionState, payload: Record<string, unknown>): boolean {
  if (
    state.stopping ||
    state.shutdown ||
    state.callerInterrupt ||
    state.interrupted ||
    state.failure ||
    state.detached ||
    state.pending.size === 0
  )
    return false;
  if (payload.type === "user") {
    const message = record(payload.message, "Cloud user message");
    if (message.role !== "user" || !Array.isArray(message.content)) return false;
    return message.content.some((value) => {
      const block = record(value, "Cloud tool result block");
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return false;
      const call = state.pending.get(block.tool_use_id);
      return (
        call !== undefined &&
        !state.callbackReplies.get(call.requestId)?.ownSequence &&
        isBackgroundedMcpResult(block.content, call.name)
      );
    });
  }
  let cancelledId: string | number | undefined;
  if (payload.type !== "result") {
    if (payload.type !== "control_request") return false;
    const request = record(payload.request, "control request");
    if (request.subtype !== "mcp_message" || request.server_name !== MCP_SERVER_NAME) return false;
    cancelledId = cancelledMcpRequestId(record(request.message, "MCP message"));
    if (cancelledId === undefined) return false;
  }
  return [...state.pending.values()].some((call) => {
    // A winning result echo completes the remote wait even if its POST receipt is still pending.
    return (
      (cancelledId === undefined || call.rpcId === cancelledId) &&
      !state.callbackReplies.get(call.requestId)?.ownSequence
    );
  });
}

function inspectDetachedWorkerEvent(
  state: SessionState,
  payload: Record<string, unknown>,
): boolean {
  if (consumeCallerInterruption(state, payload)) return true;
  const terminal = workerFailure(payload, state);
  if (terminal) latchSessionFailure(state, terminal);
  if (state.failure) throw state.failure;
  if (payload.type === "assistant") validateAssistant(payload, state);
  if (payload.type === "user") {
    if (state.ready) observeNativeDenialResults(state, payload);
    else observeBootstrapToolResults(state, payload);
  }
  if (payload.type === "system" && payload.subtype === "init") {
    observeInventory(state, { event_type: "message", payload });
  }
  if (payload.type === "result") {
    assertNativeDenialsConfirmed(state);
    if (state.bootstrapNativeCalls.size > 0)
      throw new CloudSessionSafetyError(
        "Cloud detached session left native bootstrap denials unconfirmed",
      );
  }
  return false;
}

function consumeCallerInterruption(state: SessionState, payload: Record<string, unknown>): boolean {
  const interruption = state.callerInterrupt;
  if (state.failure || !interruption?.requestId) return false;
  if (payload.type === "control_response") {
    const response = record(payload.response, "interrupt control response");
    if (response.request_id === interruption.requestId && response.subtype === "success") {
      interruption.acknowledged = true;
    }
    return false;
  }
  if (!interruption.acknowledged) return false;
  if (isWorkerInterruptionMarker(payload)) {
    interruption.markerSeen = true;
    return false;
  }
  if (
    !interruption.markerSeen ||
    payload.type !== "result" ||
    payload.subtype !== "error_during_execution" ||
    payload.is_error !== true
  )
    return false;
  // Only a correlated interrupt may ignore informational EDE diagnostics; classify every other error.
  // Never clear an existing failure or suppress an AUP/security diagnostic during shutdown.
  if (
    payload.errors !== undefined &&
    (!Array.isArray(payload.errors) ||
      payload.errors.some(
        (entry) => typeof entry !== "string" || !entry.startsWith(EDE_DIAGNOSTIC_PREFIX),
      ))
  )
    return false;
  if (payload.error !== undefined || (payload.result !== undefined && payload.result !== ""))
    return false;
  if (
    state.bootstrapNativeCalls.size > 0 ||
    [...state.nativeCalls.values()].some((call) => !call.denied)
  )
    return false;
  delete state.callerInterrupt;
  return true;
}

function isWorkerInterruptionMarker(payload: Record<string, unknown>): boolean {
  if (payload.type !== "user") return false;
  const message = record(payload.message, "interruption user message");
  if (message.role !== "user") return false;
  if (message.content === INTERRUPT_MESSAGE) return true;
  if (!Array.isArray(message.content) || message.content.length !== 1) return false;
  const block = record(message.content[0], "interruption text block");
  return block.type === "text" && block.text === INTERRUPT_MESSAGE;
}

function isPolicyOrIsolationFailure(diagnostic: string): boolean {
  return /\baup\b|acceptable\s+use|\bpolic(?:y|ies)\b|\brefusal\b|\b(?:request|prompt) (?:was )?refused\b|\brefused (?:the )?(?:request|prompt)\b|\bnonlocal tool\b|\bnative\s+(?:isolation|protection)\b|\bsecurity (?:failure|violation)\b/i.test(
    diagnostic.replace(/[_-]+/g, " "),
  );
}

function workerFailure(payload: Record<string, unknown>, state: SessionState): Error | undefined {
  if (
    payload.type === "system" &&
    ["model_fallback", "model_refusal_fallback", "model_consent_fallback"].includes(
      String(payload.subtype),
    )
  ) {
    throw new CloudSessionSafetyError(
      `Cloud reported a model fallback from ${JSON.stringify(payload.original_model ?? "<missing>")} to ${JSON.stringify(payload.fallback_model ?? "<missing>")}; requested ${JSON.stringify(state.request.model)}. No model change is permitted; the session is blocked.`,
    );
  }
  if (
    payload.type === "error" ||
    (payload.type === "result" && (payload.is_error === true || payload.subtype !== "success"))
  ) {
    const detail = resultError(payload);
    // Structured worker errors can carry their policy code/message outside result.errors.
    const diagnostics = `${detail}\n${JSON.stringify(payload.error ?? "")}\n${JSON.stringify(payload.errors ?? [])}`;
    if (isPolicyOrIsolationFailure(diagnostics)) return new CloudSessionSafetyError(detail);
    return payload.type === "error"
      ? streamErrorToHttpError({ provider: "anthropic-cloud", rawBody: JSON.stringify(payload) })
      : new Error(detail);
  }
  if (payload.type === "assistant") {
    const message = record(payload.message, "assistant message");
    const syntheticError = cloudSyntheticAssistantError(payload);
    if (!syntheticError) {
      if (typeof message.model !== "string" || !message.model.trim()) {
        throw new CloudSessionSafetyError(
          `Cloud assistant model identity is missing or invalid: requested ${JSON.stringify(state.request.model)}, received ${JSON.stringify(message.model ?? "<missing>")}. No model change was confirmed; the response is blocked.`,
        );
      }
      if (message.model !== state.request.model) {
        throw new CloudSessionSafetyError(
          `Cloud assistant model mismatch: requested ${JSON.stringify(state.request.model)}, received ${JSON.stringify(message.model)}. No model fallback is permitted; the response is blocked.`,
        );
      }
    }
    const refusal = cloudAssistantRefusal(message);
    if (refusal) {
      return syntheticError
        ? new CloudSyntheticRefusalError(payload, refusal)
        : new CloudSessionSafetyError(refusal);
    }
    return syntheticError;
  }
  return undefined;
}

interface EventConnection {
  controller: AbortController;
  ready: Promise<void>;
  finished: Promise<void>;
  reader: EventReader;
  assertOpen(): void;
}

function connectEvents(
  state: SessionState,
  controller: AbortController,
  handlers: {
    onFailure: (error: unknown) => void;
    handleCallback: (payload: Record<string, unknown>) => Promise<void>;
    onResult: () => void;
  },
): EventConnection {
  const signal = controller.signal;
  const ready = Promise.withResolvers<void>();
  const incoming = new AsyncStream<CloudEvent | null>();
  let opened = false;
  let transportEnded = false;
  let ended = false;
  let failure: Error | undefined;
  const source = sessionClient(state).events(string(state.id, "session.id"), state.cursor, signal, {
    onOpen: () => {
      opened = true;
      ready.resolve();
    },
    onReconnect: () => {
      throw new Error(
        "Cloud stream disconnected; worker protection cannot be revalidated during an active reader",
      );
    },
  });

  function fail(error: unknown): void {
    if (signal.aborted) {
      if (state.detached && error !== signal.reason) latchSessionFailure(state, error);
      return;
    }
    latchSessionFailure(state, error);
    const alreadyFailed = !!failure;
    failure = state.failure ?? state.detached?.error ?? new Error(String(error));
    if (!alreadyFailed) handlers.onFailure(failure);
    state.events.signal();
  }

  async function pump(): Promise<void> {
    try {
      // This pump never waits for a POST: even a reply's echo can race its receipt.
      for await (const event of source) {
        if (event?.source === "client") {
          try {
            observeCallbackReply(state, event);
          } catch (error) {
            if (!isDetachedSessionError(error)) throw error;
            fail(error);
          }
          continue;
        }
        if (event) {
          if (state.detached) {
            // Keep auditing until shutdown closes the transport: later terminal failures
            // must outrank any recoverable reason for detaching this session.
            try {
              if (inspectDetachedWorkerEvent(state, event.payload)) continue;
            } catch (error) {
              fail(error);
            }
          } else {
            if (consumeCallerInterruption(state, event.payload)) continue;
            const failure = workerFailure(event.payload, state);
            if (failure && terminalSessionFailure(failure)) latchSessionFailure(state, failure);
            if (abandonedLocalCall(state, event.payload)) {
              fail(new CloudLocalCallAbandonedError());
              try {
                inspectDetachedWorkerEvent(state, event.payload);
              } catch (error) {
                fail(error);
              }
            } else if (failure && !state.failure) {
              fail(failure);
              inspectDetachedWorkerEvent(state, event.payload);
            }
          }
          trackWorkerCallback(state, event.payload);
        }
        if (!state.detached) incoming.push(event);
      }
    } catch (error) {
      fail(error);
    } finally {
      opened = false;
      transportEnded = true;
      ready.reject(failure ?? new Error("Cloud event reader closed before SSE was ready"));
      incoming.signal();
    }
  }

  async function dispatch(): Promise<void> {
    try {
      await ready.promise;
      for await (const event of incoming.iterate(() => transportEnded)) {
        if (failure || signal.aborted) {
          if (state.detached && event) inspectDetachedWorkerEvent(state, event.payload);
          continue;
        }
        if (event && observeInventory(state, event)) continue;
        if (event?.payload.type === "control_request" && isInfrastructureCallback(event.payload)) {
          await handlers.handleCallback(event.payload);
          continue;
        }
        // Only the foreground harness consumer can turn tools/call into a local dispatch.
        state.events.push(event);
        if (event?.payload.type === "result" || event?.payload.type === "error")
          handlers.onResult();
      }
    } catch (error) {
      fail(error);
    } finally {
      ended = true;
      state.events.signal();
    }
  }

  async function* read(): EventReader {
    for await (const event of state.events.iterate(() => ended || !!failure)) {
      if (failure) throw state.failure ?? failure;
      yield event;
    }
    if (failure) throw state.failure ?? failure;
  }

  return {
    controller,
    ready: ready.promise,
    finished: Promise.all([pump(), dispatch()]).then(() => undefined),
    reader: read(),
    assertOpen() {
      if (failure) throw state.failure ?? failure;
      if (!opened) throw new Error("Cloud session event stream is not connected");
    },
  };
}

function isInfrastructureCallback(payload: Record<string, unknown>): boolean {
  const request = record(payload.request, "control request");
  if (request.subtype !== "mcp_message") return true;
  return record(request.message, "MCP message").method !== "tools/call";
}

function trackWorkerCallback(state: SessionState, payload: Record<string, unknown>): void {
  if (payload.type !== "control_request") return;
  const request = record(payload.request, "control request");
  const isOwned =
    request.subtype === "hook_callback" ||
    request.subtype === "can_use_tool" ||
    (request.subtype === "mcp_message" && request.server_name === MCP_SERVER_NAME);
  if (!isOwned) return;
  const id = string(payload.request_id, "callback request_id");
  if (!state.callbackReplies.has(id))
    state.callbackReplies.set(id, { echoed: Promise.withResolvers<void>() });
  if (request.subtype === "hook_callback") state.pendingHooks.add(id);
}

function observeCallbackReply(state: SessionState, event: CloudEvent): void {
  if (event.payload.type !== "control_response") return;
  const response = record(event.payload.response, "client control response");
  const requestId = string(response.request_id, "callback response request_id");
  const callback = state.callbackReplies.get(requestId);
  if (!callback) return;
  const uuid = event.payload.uuid;
  if (typeof uuid === "string" && state.replyUuids.get(uuid) === requestId) {
    if (callback.stolen) return;
    // Only the ordered durable echo proves our reply won. Enqueuing a POST is not evidence.
    if (event.sequence_num) {
      callback.ownSequence ??= event.sequence_num;
      callback.echoed.resolve();
    }
    return;
  }
  if (
    callback.ownSequence &&
    event.sequence_num &&
    BigInt(event.sequence_num) > BigInt(callback.ownSequence)
  )
    return;
  callback.stolen = true;
  state.pendingHooks.delete(requestId);
  throw state.detached?.error ?? new CloudCallbackContentionError();
}

function assertEventConnection(state: SessionState): void {
  if (!state.connection) throw new Error("Cloud session event reader is not active");
  state.connection.assertOpen();
}

function sessionClient(state: SessionState): CloudClient {
  if (!state.client) throw new Error("Cloud session has no bound credential identity");
  return state.client;
}

function controlPayload(request: Record<string, unknown>): Record<string, unknown> {
  return { type: "control_request", uuid: randomUUID(), request_id: randomUUID(), request };
}

function localToolGuidance(cwd: string): string {
  return `${LOCAL_TOOL_GUIDANCE}\nLocal working directory on the Otherside client (JSON string): ${JSON.stringify(cwd)}. All ${MCP_TOOL_PREFIX}<toolName> path arguments refer to the local client filesystem; relative paths resolve against this local working directory. The Cloud worker's filesystem and working directory are not the client's: do not infer local paths from remote /home/user or substitute remote paths for local ones. Preserve explicitly supplied paths; do not silently rewrite tool inputs.`;
}

function snapshotRequestContent(request: CloudRequest): Record<string, unknown>[] {
  const last = request.messages.at(-1);
  const current =
    last?.role === "user"
      ? last.content.filter((block) => block.type === "text" || block.type === "image")
      : [];
  let historical = request.messages;
  if (last?.role === "user" && current.length > 0) {
    historical = request.messages.slice(0, -1);
    const retained = last.content.filter(
      (block) => block.type !== "text" && block.type !== "image",
    );
    if (retained.length > 0) historical.push({ ...last, content: retained });
  }
  const content = buildCloudHistorySnapshot(historical, {
    provider: "anthropic-cloud",
    model: request.model,
  });
  content.push({ type: "text", text: CURRENT_REQUEST_FRAME });
  if (current.length > 0) content.push(...cloudUserContent(current));
  else content.push({ type: "text", text: SNAPSHOT_CONTINUATION });
  return content;
}

function needsInitialSnapshot(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role !== "user" || message.content.some((block) => block.type === "tool_result"),
  );
}

function observePendingCancellation(state: SessionState): void {
  const pending = state.pendingCaller;
  if (!pending?.signal.aborted) return;
  // A caller can cancel while the local harness runs a tool and the Cloud reader is closed.
  if (isExplicitCancellation(pending.signal, pending.signal.reason, pending.signal)) {
    state.interrupted ??= { messages: pending.messages };
  } else {
    const reason: unknown = pending.signal.reason;
    latchSessionFailure(state, reason);
  }
}

function canReplaceIdleWorker(state: SessionState, request: CloudRequest): boolean {
  if (
    !state.ready ||
    state.failure ||
    state.detached ||
    state.interrupted ||
    state.activeTurn ||
    state.history.length === 0
  )
    return false;
  if (
    state.pending.size > 0 ||
    state.pendingHooks.size > 0 ||
    state.activeCallbacks > 0 ||
    state.backlog.length > 0
  )
    return false;
  if ([...state.nativeCalls.values()].some((call) => !call.denied)) return false;
  // Only a fresh user turn may cold-resume an idle recycled worker, never a retry or tool continuation.
  return request.messages.slice(state.history.length).some(hasUserPrompt);
}

function rotationReason(state: SessionState, request: CloudRequest): SnapshotReason | undefined {
  if (state.detached) {
    if (
      !hasNewInput(
        userPromptMessages(state.detached.messages),
        userPromptMessages(request.messages),
      )
    ) {
      throw state.detached.error;
    }
    assertHistoryPrefix(state, request);
    return state.detached.reason;
  }
  if (state.interrupted) {
    if (state.interrupted.reason === "local-rejection") {
      if (
        !hasNewInput(
          userPromptMessages(state.interrupted.messages),
          userPromptMessages(request.messages),
        )
      ) {
        throw new Error(
          "Cloud tool turn was stopped by local rejection; a new user prompt is required, not a retry",
        );
      }
      return "local-rejection";
    }
    if (!hasNewInput(state.interrupted.messages, request.messages)) {
      throw new Error(
        "Cloud request was interrupted; a new user prompt or local rejection is required, not a retry",
      );
    }
    return "interruption";
  }
  if (state.compactionPending) return "compaction";
  assertHistoryPrefix(state, request);
  if (state.request.systemPrompt !== request.systemPrompt || state.request.cwd !== request.cwd)
    return "system-change";
  const fresh = request.messages.slice(state.history.length);
  const hasNewUser = fresh.some(hasUserPrompt);
  const hasLocalRejection = fresh.some((message) =>
    message.content.some((block) => {
      return (
        block.type === "tool_result" &&
        block.is_error === true &&
        state.pending.has(block.tool_use_id)
      );
    }),
  );
  if (state.pending.size > 0 && hasLocalRejection && hasNewUser) return "local-rejection";
  return undefined;
}

function assertHistoryPrefix(state: SessionState, request: CloudRequest): void {
  if (
    state.history.some((identity, index) => {
      const message = request.messages[index];
      return !message || identity !== messageIdentity(message);
    })
  ) {
    throw new Error(
      "Cloud conversation prefix changed; compaction must reset session continuity explicitly",
    );
  }
}

function userPromptMessages(messages: readonly Message[]): Message[] {
  return messages.filter(hasUserPrompt).map((message) => ({
    ...message,
    content: message.content.filter((block) => block.type !== "tool_result"),
  }));
}

function hasNewInput(previous: readonly Message[], next: readonly Message[]): boolean {
  const counts = new Map<string, number>();
  for (const key of inputIdentities(previous)) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of inputIdentities(next)) {
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
  }
  return false;
}

function inputIdentities(messages: readonly Message[]): string[] {
  const inputs: string[] = [];
  for (const message of messages) {
    if (hasUserPrompt(message)) {
      inputs.push(
        JSON.stringify(["user", message.content.filter((block) => block.type !== "tool_result")]),
      );
    }
    for (const block of message.content) {
      if (block.type === "tool_result" && block.is_error === true)
        inputs.push(JSON.stringify(block));
    }
  }
  return inputs;
}

function hasUserPrompt(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.some((block) => {
      if (block.type === "image") return true;
      return (
        block.type === "text" &&
        !!block.text.trim() &&
        !block.reminder_type &&
        !isInterruptionMessage(block.text)
      );
    })
  );
}

function isExplicitCancellation(
  signal: AbortSignal,
  error: unknown,
  callerSignal?: AbortSignal,
): boolean {
  // The aggregated attempt signal also carries watchdog failures. Only caller cancellation can recover.
  const caller = callerSignal ?? (signal.reason === "user-cancel" ? signal : undefined);
  if (!signal.aborted || !caller?.aborted || signal.reason !== caller.reason) return false;
  const reason: unknown = caller.reason;
  const isUserCancel =
    reason === "user-cancel" || (reason instanceof Error && reason.name === "AbortError");
  return (
    isUserCancel && (error === reason || (error instanceof Error && error.name === "AbortError"))
  );
}

async function completeShutdown(
  state: SessionState,
  shutdown: Promise<void> | undefined,
): Promise<void> {
  try {
    await shutdown;
  } catch (error) {
    latchSessionFailure(state, error);
    delete state.interrupted;
    throw state.failure ?? state.detached?.error ?? error;
  }
}

async function closeEventReader(
  state: SessionState,
  reader: EventReader | undefined,
): Promise<void> {
  await state.connection?.finished;
  await (reader ?? state.connection?.reader)?.return(undefined);
  delete state.connection;
}

function messageIdentity(message: Message): string {
  return JSON.stringify([message.role, message.content]);
}

function workerPid(response: Record<string, unknown>): string {
  const pid = response.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) return String(pid);
  throw new Error("Cloud initialize did not confirm a worker pid");
}

function observeInventory(state: SessionState, event: CloudEvent): boolean {
  const payload = event.payload;
  if (payload.type !== "system" || payload.subtype !== "init") return false;
  if (
    !Array.isArray(payload.tools) ||
    payload.tools.some((name) => typeof name !== "string" || !name)
  ) {
    throw new CloudSessionSafetyError("Cloud system/init did not provide a valid tool inventory");
  }
  const nativeTools = new Set(
    payload.tools.filter(
      (name): name is string => typeof name === "string" && !name.startsWith(MCP_TOOL_PREFIX),
    ),
  );
  if (state.ready && [...nativeTools].some((name) => !isProtectedNativeTool(state, name))) {
    throw new CloudSessionSafetyError("Cloud worker advertised new unprotected tools");
  }
  if (!state.ready) {
    for (const name of nativeTools) state.nativeTools.add(name);
    state.inventoryReceived = state.nativeTools.size > 0;
  }
  return true;
}

function validateAssistant(payload: Record<string, unknown>, state: SessionState): void {
  const message = record(payload.message, "assistant message");
  const failure = workerFailure(payload, state);
  if (failure) {
    latchSessionFailure(state, failure);
    if (!state.ready || cloudSyntheticAssistantError(payload)) throw failure;
  }
  if (!Array.isArray(message.content)) throw new Error("Cloud assistant content is missing");
  for (const value of message.content) {
    const block = record(value, "assistant block");
    if (block.type === "tool_use" && !isRegisteredCloudTool(block.name, state.tools)) {
      if (canRecoverNativeDenial(state, block.name)) {
        const id = string(block.id, "native tool_use.id");
        const name = normalizeNativeToolName(string(block.name, "native tool_use.name"));
        const previous = state.nativeCalls.get(id);
        if (previous && previous.name !== name)
          throw new CloudSessionSafetyError(
            "Cloud reused a native tool-use ID for a different tool",
          );
        if (!previous) state.nativeCalls.set(id, { name, denied: false });
        continue;
      }
      if (state.ready || !state.activeTurn)
        throw new CloudSessionSafetyError(`Cloud attempted a nonlocal tool: ${String(block.name)}`);
      state.bootstrapNativeCalls.set(
        string(block.id, "native tool_use.id"),
        string(block.name, "native tool_use.name"),
      );
    }
  }
}

function isProtectedNativeTool(state: SessionState, name: unknown): boolean {
  if (typeof name !== "string") return false;
  const canonical = normalizeNativeToolName(name);
  return [...state.nativeTools].some((tool) => normalizeNativeToolName(tool) === canonical);
}

function canRecoverNativeDenial(state: SessionState, name: unknown): boolean {
  return (
    state.ready &&
    state.verified &&
    state.activeTurn &&
    (isProtectedNativeTool(state, name) || name === `${MCP_TOOL_PREFIX}${CLOUD_CONNECT_TOOL_NAME}`)
  );
}

function observeNativeDenialResults(state: SessionState, payload: Record<string, unknown>): void {
  const message = record(payload.message, "Cloud user message");
  if (!Array.isArray(message.content)) return;
  for (const value of message.content) {
    const block = record(value, "Cloud tool result block");
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const call = state.nativeCalls.get(block.tool_use_id);
    if (!call) continue;
    // Session deny rules can reject before PreToolUse; unlike bootstrap, no hook count is needed.
    if (block.is_error !== true) {
      throw new CloudSessionSafetyError(
        `Cloud native tool ${call.name} returned a result without confirmed denial`,
      );
    }
    call.denied = true;
  }
}

function assertNativeDenialsConfirmed(state: SessionState): void {
  if ([...state.nativeCalls.values()].some((call) => !call.denied)) {
    throw new CloudSessionSafetyError(
      "Cloud turn ended without confirming all native tool denial results",
    );
  }
}

function observeBootstrapToolResults(state: SessionState, payload: Record<string, unknown>): void {
  const message = record(payload.message, "bootstrap user message");
  if (!Array.isArray(message.content)) return;
  for (const value of message.content) {
    const block = record(value, "bootstrap result block");
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    if (block.is_error === true && block.tool_use_id === state.bootstrapPermissionId) {
      const texts = typeof block.content === "string" ? [block.content] : [];
      if (Array.isArray(block.content)) {
        for (const value of block.content) {
          const content = record(value, "bootstrap result content");
          if (content.type === "text" && typeof content.text === "string") texts.push(content.text);
        }
      }
      if (texts.some((text) => text.includes(`SDK MCP server not found: ${MCP_SERVER_NAME}`))) {
        throw new Error(
          `Cloud bootstrap SDK callback failed: SDK MCP server not found: ${MCP_SERVER_NAME}`,
        );
      }
    }
    const name = state.bootstrapNativeCalls.get(block.tool_use_id);
    if (!name) continue;
    const denials = state.bootstrapHookDenials.get(name) ?? 0;
    if (block.is_error !== true || denials < 1) {
      throw new CloudSessionSafetyError(
        `Cloud bootstrap did not confirm hook denial of native tool ${name}`,
      );
    }
    state.bootstrapNativeCalls.delete(block.tool_use_id);
    state.bootstrapHookDenials.set(name, denials - 1);
  }
}

function localCallEvent(
  event: CloudEvent,
  call: PendingToolCall,
  snapshot: { usage: Usage; contextTokens: number | null | undefined },
): CloudEvent {
  const request = record(event.payload.request, "MCP request");
  const rpc = record(request.message, "MCP message");
  const params = record(rpc.params, "MCP params");
  return {
    ...event,
    payload: withContextTokens(
      {
        ...event.payload,
        usage: snapshot.usage,
        request: { ...request, message: { ...rpc, params: { ...params, name: call.name } } },
      },
      snapshot.contextTokens,
    ),
  };
}

function normalizeUsage(state: SessionState, event: CloudEvent): CloudEvent {
  const payload = event.payload;
  if (payload.type === "assistant") {
    const message = record(payload.message, "assistant message");
    if (message.usage)
      state.usage.set(string(message.id, "assistant id"), readUsage(message.usage));
    updateContextTokens(state, message);
    return {
      ...event,
      payload: withContextTokens(
        { ...payload, message: { ...message, usage: roundUsage(state) } },
        state.contextTokens,
      ),
    };
  }
  if (state.usage.size === 0) state.usage.set("result", readUsage(payload.usage ?? {}));
  // SDK result.usage is cumulative; assistant usage already accounts for the same inference.
  return {
    ...event,
    payload: withContextTokens({ ...payload, usage: roundUsage(state) }, state.contextTokens),
  };
}

function withContextTokens(
  payload: Record<string, unknown>,
  contextTokens: number | null | undefined,
): Record<string, unknown> {
  const normalized = { ...payload };
  // This metadata exists only on the local normalized stream, never on a Cloud POST.
  delete normalized.contextTokens;
  if (contextTokens !== undefined) normalized.contextTokens = contextTokens;
  return normalized;
}

function updateContextTokens(state: SessionState, message: Record<string, unknown>): void {
  const id = string(message.id, "assistant id");
  if (message.usage === undefined && state.contextMessageId === id) return;
  state.contextMessageId = id;
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    state.contextTokens = null;
    return;
  }
  const counters = record(usage, "assistant context usage");
  const values = [
    counters.input_tokens,
    counters.output_tokens,
    counters.cache_creation_input_tokens === undefined ? 0 : counters.cache_creation_input_tokens,
    counters.cache_read_input_tokens === undefined ? 0 : counters.cache_read_input_tokens,
  ];
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      state.contextTokens = null;
      return;
    }
    total += value;
  }
  if (Number.isFinite(total)) state.contextTokens = total;
  else state.contextTokens = null;
}

function resetContextTokens(state: SessionState): void {
  delete state.contextMessageId;
  delete state.contextTokens;
}

function readUsage(value: unknown): Usage {
  const usage = record(value, "usage");
  const result: Usage = {};
  for (const field of USAGE_FIELDS) {
    const count = usage[field];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) result[field] = count;
  }
  return result;
}

function totalUsage(messages: Map<string, Usage>): Usage {
  const total: Usage = {};
  for (const usage of messages.values()) {
    for (const field of USAGE_FIELDS) total[field] = (total[field] ?? 0) + (usage[field] ?? 0);
  }
  return total;
}

function totalUsageWithBootstrap(state: SessionState): Usage {
  const total = totalUsage(state.usage);
  for (const field of USAGE_FIELDS)
    total[field] = (total[field] ?? 0) + (state.bootstrapUsage[field] ?? 0);
  return total;
}

function roundUsage(state: SessionState): Usage {
  const total = totalUsageWithBootstrap(state);
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => [
      field,
      Math.max(0, (total[field] ?? 0) - (state.accountedUsage[field] ?? 0)),
    ]),
  );
}

function abortableNext(
  reader: EventReader,
  signal: AbortSignal,
): Promise<IteratorResult<CloudEvent | null>> {
  signal.throwIfAborted();
  return abortable(reader.next(), signal);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const winKeepAlive =
    process.platform === "win32" && !signal.aborted ? setInterval(() => {}, 10) : undefined;
  try {
    return await Promise.race([aborted.promise, promise]);
  } finally {
    if (winKeepAlive !== undefined) clearInterval(winKeepAlive);
    signal.removeEventListener("abort", abort);
  }
}
