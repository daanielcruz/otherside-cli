import { listBackgroundTasks } from "@/kernel/channels/background-tasks.ts";
import {
  answer as answerPermission,
  find as findPendingPermission,
  type PendingPermission,
  PermissionResults,
} from "@/kernel/channels/permission.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import type { ContentBlock, ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { CortexApiError, cortexFetch } from "@/remote/_infra/cortex.ts";
import { decryptEvent } from "@/remote/crypto/e2ee.ts";
import type { Device } from "@/remote/devices/device.ts";
import { buildIncomingMessage } from "@/remote/session/inbound.ts";
import { applyAskResponse } from "../ask-response.ts";
import {
  authFailureStatus,
  claimOutgoingCounters,
  persistSyncedIndex,
  type RatchetCacheEntry,
  ratchetKeyFor,
  sendEncryptedEvent,
  sendEncryptedEventBatch,
} from "../crypto.ts";

const DEC = new TextDecoder();

const PROCESSED_EVENT_CAP = 5000;
const REORDER_WINDOW = 16;

export interface IncomingSyncState {
  cursorTs: string | null;
  processed: Set<string>;
  ratchet: Map<string, RatchetCacheEntry>;
  watermark: Map<string, number>;
}

export type QueuedMessageHandler = (
  text: string,
  blocks?: ContentBlock[],
  payload?: unknown,
) => void;
export type CancelQueuedMessageHandler = (message: { text: string; queueId?: string }) => void;

export interface IncomingRowDeps {
  device: Device;
  session: Session;
  sessionKey: Uint8Array;
  broker: Broker;
  state: IncomingSyncState;
  onIncomingMessage?: ((text: string, blocks?: ContentBlock[]) => void) | undefined;
  onQueuedMessage?: QueuedMessageHandler | undefined;
  onCancelQueuedMessage?: CancelQueuedMessageHandler | undefined;
}

function toCliPermissionMode(mode: string): PermissionMode {
  if (mode === "accept") return "accept-edits";
  if (mode === "auto") return "default";
  return mode as PermissionMode;
}

function remotePermissionResult(
  pending: PendingPermission,
  response: string,
  feedback: string | undefined,
): ReturnType<typeof PermissionResults.allow> | null {
  if (response === "allow") return PermissionResults.allow();
  if (response === "deny") return PermissionResults.deny(feedback);
  if (response === "allow_always") {
    // Persist only the CLI-computed rule — a companion-supplied rule string
    // would let a paired device mint arbitrary persistent grants (e.g. Bash(*)).
    return pending.rule ? PermissionResults.allowAlways(pending.rule) : PermissionResults.allow();
  }
  // Mode escalations exist only on the ExitPlanMode prompt; for any other
  // pending tool they are ignored and the prompt stays up (fail-closed).
  const isPlanPrompt = pending.toolName === "ExitPlanMode";
  if (response === "plan_bypass") return isPlanPrompt ? PermissionResults.setMode("yolo") : null;
  if (response === "plan_accept_edits") {
    return isPlanPrompt ? PermissionResults.setMode("accept-edits") : null;
  }
  // "manually approve edits" — kept alongside plan_accept_edits (retained for
  // companion compatibility) rather than replacing it.
  if (response === "plan_default") {
    return isPlanPrompt ? PermissionResults.setMode("default") : null;
  }
  if (response === "plan_feedback") return PermissionResults.planFeedback(feedback ?? "");
  return null;
}

function toResultBase(result: unknown): Record<string, unknown> {
  if (typeof result === "string") return { content: result };
  if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  return {};
}

function richResultForSync(result: unknown, meta: ToolResultMeta): Record<string, unknown> {
  const { kind: _kind, ...rest } = meta;
  return { content: typeof result === "string" ? result : "", ...rest };
}

export function isSyncableEvent(ev: Record<string, unknown>): boolean {
  const eventType = ev.type;
  if (
    eventType !== "user_message" &&
    eventType !== "change_model" &&
    eventType !== "change_permission_mode" &&
    eventType !== "permission_response" &&
    eventType !== "ask_response" &&
    eventType !== "queued_input" &&
    eventType !== "cancel_queued_input" &&
    eventType !== "queued_input_cancelled"
  ) {
    return false;
  }
  return !!ev.payload && typeof ev.payload === "object" && "ct" in ev.payload;
}

export function applyIncomingEvent(deps: {
  eventType: string;
  parsed: unknown;
  session: Session;
  broker: Broker;
  onIncomingMessage?: ((text: string, blocks?: ContentBlock[]) => void) | undefined;
  onQueuedMessage?: QueuedMessageHandler | undefined;
  onCancelQueuedMessage?: CancelQueuedMessageHandler | undefined;
}): void {
  const {
    eventType,
    parsed,
    session,
    broker,
    onIncomingMessage,
    onQueuedMessage,
    onCancelQueuedMessage,
  } = deps;
  if (eventType === "queued_input") {
    const incoming = buildIncomingMessage(session.id, parsed);
    if (!incoming) return;
    onQueuedMessage?.(incoming.text, incoming.blocks, parsed);
    return;
  }
  if (eventType === "user_message") {
    const incoming = buildIncomingMessage(session.id, parsed);
    if (!incoming) return;
    const exists = session.records.some(
      (r) => r.type === "user_message" && r.content === incoming.text,
    );
    if (!exists) onIncomingMessage?.(incoming.text, incoming.blocks);
    return;
  }
  if (eventType === "cancel_queued_input" || eventType === "queued_input_cancelled") {
    const cancelPayload = parsed as {
      text?: string;
      queueId?: string;
      queue_id?: string;
      id?: string;
    };
    const queueId = cancelPayload.queueId ?? cancelPayload.queue_id ?? cancelPayload.id;
    if (cancelPayload.text) {
      onCancelQueuedMessage?.({
        text: cancelPayload.text,
        ...(typeof queueId === "string" ? { queueId } : {}),
      });
    }
    return;
  }
  if (eventType === "change_model") {
    const modelChange = parsed as { provider?: string; model?: string };
    if (modelChange.provider && modelChange.model) {
      broker.dispatch({
        kind: "set_provider",
        provider: modelChange.provider as ProviderId,
        model: modelChange.model,
      });
    }
    return;
  }
  if (eventType === "permission_response") {
    const permissionResponse = parsed as {
      id?: string;
      response?: string;
      feedback?: string;
    };
    if (permissionResponse.id && permissionResponse.response) {
      const pending = findPendingPermission(permissionResponse.id);
      if (!pending) return;
      const result = remotePermissionResult(
        pending,
        permissionResponse.response,
        permissionResponse.feedback,
      );
      if (result) answerPermission(permissionResponse.id, result);
    }
    return;
  }
  if (eventType === "ask_response") {
    applyAskResponse(parsed);
    return;
  }
  const modeChange = parsed as { mode?: string };
  if (modeChange.mode) {
    broker.dispatch({ kind: "set_permission_mode", mode: toCliPermissionMode(modeChange.mode) });
  }
}

export function isCounterAcceptable(
  state: IncomingSyncState,
  senderDeviceId: string,
  counter: number,
): boolean {
  const high = state.watermark.get(senderDeviceId) ?? 0;
  if (counter > high) return true;
  return counter > high - REORDER_WINDOW;
}

export function applyIncomingRow(ev: Record<string, unknown>, deps: IncomingRowDeps): void {
  const { device, session, sessionKey, broker, state } = deps;
  const ts = typeof ev.ts === "string" ? ev.ts : null;
  if (ts && (!state.cursorTs || ts > state.cursorTs)) state.cursorTs = ts;

  if (!isSyncableEvent(ev)) return;
  const eventType = ev.type as string;
  const senderDeviceId = ev.sender_device_id as string | undefined;
  if (!senderDeviceId || senderDeviceId === device.id) return;
  const payload = ev.payload as { c?: number; n?: string; ct?: string; v?: number };
  const counter = payload.c;
  if (!counter) return;

  const dedupeKey = `${senderDeviceId}:${counter}`;
  if (state.processed.has(dedupeKey)) return;
  if (!isCounterAcceptable(state, senderDeviceId, counter)) return;

  try {
    const ratchetKey = ratchetKeyFor(state.ratchet, sessionKey, senderDeviceId, counter);
    const plaintextBytes = decryptEvent({
      ratchetKey,
      sessionId: session.id,
      eventType,
      senderDeviceId,
      envelope: {
        v: (payload.v ?? 1) as 1,
        c: counter,
        n: payload.n ?? "",
        ct: payload.ct ?? "",
      },
    });
    const parsed = JSON.parse(DEC.decode(plaintextBytes));
    applyIncomingEvent({
      eventType,
      parsed,
      session,
      broker,
      onIncomingMessage: deps.onIncomingMessage,
      onQueuedMessage: deps.onQueuedMessage,
      onCancelQueuedMessage: deps.onCancelQueuedMessage,
    });
    state.processed.add(dedupeKey);
    if (state.processed.size > PROCESSED_EVENT_CAP) {
      const oldest = state.processed.values().next().value;
      if (oldest) state.processed.delete(oldest);
    }
    const high = state.watermark.get(senderDeviceId) ?? 0;
    if (counter > high) state.watermark.set(senderDeviceId, counter);
  } catch (err) {
    process.stderr.write(
      `remote: decrypt failed sender=${senderDeviceId} counter=${counter} type=${eventType} reason=${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export async function syncIncomingEvents(deps: {
  device: Device;
  session: Session;
  accessToken: string;
  sessionKey: Uint8Array;
  broker: Broker;
  state: IncomingSyncState;
  onIncomingMessage?: ((text: string, blocks?: ContentBlock[]) => void) | undefined;
  onQueuedMessage?: QueuedMessageHandler | undefined;
  onCancelQueuedMessage?: CancelQueuedMessageHandler | undefined;
}): Promise<401 | 403 | null> {
  const {
    device,
    session,
    accessToken,
    sessionKey,
    broker,
    state,
    onIncomingMessage,
    onQueuedMessage,
    onCancelQueuedMessage,
  } = deps;
  try {
    const events = await cortexFetch<
      Array<{
        id: string;
        session_id: string;
        sender_device_id: string | null;
        type: string;
        payload: Record<string, unknown>;
        counter: number | null;
        ts: string;
      }>
    >(`/v1/sessions/${session.id}/events`, {
      method: "GET",
      token: accessToken,
    });
    // Newest-first from cortex keyset — process chronological for ratchet.
    const ordered = [...events].reverse();
    for (const ev of ordered) {
      if (ev.sender_device_id === device.id) continue;
      if (state.cursorTs && ev.ts < state.cursorTs) continue;
      applyIncomingRow(
        {
          id: ev.id,
          session_id: ev.session_id,
          sender_device_id: ev.sender_device_id,
          type: ev.type,
          payload: ev.payload,
          counter: ev.counter,
          ts: ev.ts,
        },
        {
          device,
          session,
          sessionKey,
          broker,
          state,
          onIncomingMessage,
          onQueuedMessage,
          onCancelQueuedMessage,
        },
      );
    }
    return null;
  } catch (err) {
    if (err instanceof CortexApiError) {
      return authFailureStatus(err.httpStatus || (err.code === "unauthorized" ? 401 : 0));
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split("\n")[0]?.trim() ?? "";
}

function wireDisplayPath(filePath: string): string {
  return getDisplayPath(filePath).replaceAll("\\", "/");
}

// One-line label stamped on the wire so the companion renders a clean summary
// instead of falling back to the raw file_path. Returns "" when no useful
// label can be derived — the app's own fallbacks then apply.
export function wireToolCallSummary(toolName: string, args: unknown): string {
  const a = asRecord(args);
  if (!a) return "";
  const filePath = typeof a.file_path === "string" ? a.file_path : "";
  const displayPath = filePath ? wireDisplayPath(filePath) : "";

  switch (toolName) {
    case "Edit":
    case "MultiEdit":
    case "Write":
      return displayPath;
    case "Read": {
      if (!displayPath) return "";
      const pages = typeof a.pages === "string" ? a.pages : "";
      if (pages) return `${displayPath} · pages ${pages}`;
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (offset !== undefined && limit !== undefined) {
        return `${displayPath} · lines ${offset}-${offset + Math.max(0, limit - 1)}`;
      }
      if (offset !== undefined) return `${displayPath} · from line ${offset}`;
      if (limit !== undefined) return `${displayPath} · lines 1-${limit}`;
      return displayPath;
    }
    case "Bash":
      return firstLine(a.command);
    case "WebSearch":
      return typeof a.query === "string" ? a.query : "";
    case "WebFetch":
      return typeof a.url === "string" ? a.url : "";
    case "Agent":
      return typeof a.description === "string" ? a.description : "";
    case "LSP": {
      const op = typeof a.operation === "string" ? a.operation : "";
      const path = typeof a.filePath === "string" ? wireDisplayPath(a.filePath) : "";
      if (op && path) return `${op} ${path}`;
      return op || path;
    }
    default:
      return "";
  }
}

function encodeOutgoingRecord(
  session: Session,
  idx: number,
): { wireType: string; plaintext: string } | null {
  const r = session.records[idx];
  if (!r) return null;

  if (r.type === "user_message") {
    if (r.isRemote) return null;
    return {
      wireType: r.type,
      plaintext: JSON.stringify({
        text: r.content,
        ...(r.inlineImages?.length ? { inlineImages: r.inlineImages } : {}),
        ...(r.queueId ? { queueId: r.queueId } : {}),
      }),
    };
  }
  if (r.type === "assistant_message") {
    return {
      wireType: r.type,
      plaintext: JSON.stringify({ text: r.content, thinking: r.thinking }),
    };
  }
  if (r.type === "tool_call") {
    const toolName = r.tool_name ?? "";
    return {
      wireType: r.type,
      plaintext: JSON.stringify({
        name: toolName,
        args: r.args,
        call_id: r.call_id,
        state: "running",
        summary: wireToolCallSummary(toolName, r.args),
      }),
    };
  }
  if (r.type === "tool_result") {
    let toolName = "";
    for (let i = idx; i >= 0; i--) {
      const prev = session.records[i];
      if (prev && prev.type === "tool_call" && prev.call_id === r.call_id) {
        toolName = prev.tool_name ?? "";
        break;
      }
    }
    const isTask = ["TaskCreate", "TaskList", "TaskUpdate", "TaskGet"].includes(toolName);
    let resultPayload = r.meta ? richResultForSync(r.result, r.meta as ToolResultMeta) : r.result;
    if (isTask) {
      const list = listBackgroundTasks();
      const items = list.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner ?? null,
        blockedBy: t.blockedBy,
      }));
      resultPayload = { ...toResultBase(r.result), tasks: items };
    }
    return {
      wireType: r.type,
      plaintext: JSON.stringify({
        result: resultPayload,
        is_error: r.is_error,
        call_id: r.call_id,
      }),
    };
  }
  if (r.type === "injection_queued" && r.source === "user") {
    return {
      wireType: "queued_input",
      plaintext: JSON.stringify({ text: r.text, source: r.source }),
    };
  }
  return null;
}

const OUTBOX_BATCH_LIMIT = 25;

export interface OutgoingSyncResult {
  idx: number;
  authStatus: 401 | 403 | null;
  retryable?: boolean;
  // Server refused the insert for a non-duplicate reason (e.g. the sessions
  // row is gone or owned by another account). The cursor must not advance.
  rejected?: string;
}

export async function syncOutgoingEvents(deps: {
  device: Device;
  session: Session;
  userId: string;
  accessToken: string;
  sessionKey: Uint8Array;
  ratchet: Map<string, RatchetCacheEntry>;
  fromIndex: number;
}): Promise<OutgoingSyncResult> {
  const { device, session, userId, accessToken, sessionKey, ratchet, fromIndex } = deps;

  const sendSerial = async (
    items: Array<{ index: number; wireType: string; plaintext: string; counter: number }>,
  ): Promise<OutgoingSyncResult | null> => {
    for (const item of items) {
      try {
        const result = await sendEncryptedEvent({
          device,
          session,
          userId,
          accessToken,
          sessionKey,
          ratchet,
          eventType: item.wireType,
          plaintext: item.plaintext,
          counter: item.counter,
        });
        if (result.kind === "auth") {
          return { idx: item.index, authStatus: result.status };
        }
        if (result.kind === "rejected") {
          return { idx: item.index, authStatus: null, rejected: result.detail };
        }
        if (result.kind === "retryable") {
          return { idx: item.index, authStatus: null, retryable: true };
        }
      } catch {
        return { idx: item.index, authStatus: null, retryable: true };
      }
      // Persist per delivered event on this path: a crash mid-way must not
      // rewind the cursor behind rows the server already accepted.
      persistSyncedIndex(session.id, item.index + 1);
    }
    return null;
  };

  let idx = fromIndex;
  while (idx < session.records.length) {
    const first = encodeOutgoingRecord(session, idx);
    if (!first) {
      idx++;
      continue;
    }
    // Gather a contiguous run of syncable records so counter claims stay
    // dense over record indexes (a per-record retry maps by index offset).
    const encoded = [{ index: idx, ...first }];
    while (encoded.length < OUTBOX_BATCH_LIMIT && idx + encoded.length < session.records.length) {
      const next = encodeOutgoingRecord(session, idx + encoded.length);
      if (!next) break;
      encoded.push({ index: idx + encoded.length, ...next });
    }
    const counters = claimOutgoingCounters(session.id, idx, encoded.length);
    const items = encoded.map((item, i) => {
      const counter = counters[i];
      if (counter === undefined) throw new Error("counter claim shorter than batch");
      return { ...item, counter };
    });

    if (items.length === 1) {
      const halted = await sendSerial(items);
      if (halted) return halted;
      idx += 1;
      continue;
    }

    let batchResult: Awaited<ReturnType<typeof sendEncryptedEventBatch>>;
    try {
      batchResult = await sendEncryptedEventBatch({
        device,
        session,
        userId,
        accessToken,
        sessionKey,
        ratchet,
        items: items.map((item) => ({
          eventType: item.wireType,
          plaintext: item.plaintext,
          counter: item.counter,
        })),
      });
    } catch {
      return { idx, authStatus: null, retryable: true };
    }
    if (batchResult.kind === "auth") {
      return { idx, authStatus: batchResult.status };
    }
    if (batchResult.kind === "rejected") {
      return { idx, authStatus: null, rejected: batchResult.detail };
    }
    if (batchResult.kind === "retryable") {
      return { idx, authStatus: null, retryable: true };
    }
    if (batchResult.kind === "conflict") {
      // The batch insert is atomic, so a 409 means some row already exists
      // and nothing landed. Re-send row by row: the serial path resolves
      // each row as delivered or duplicate individually.
      const halted = await sendSerial(items);
      if (halted) return halted;
      idx += items.length;
      continue;
    }
    idx += items.length;
    persistSyncedIndex(session.id, idx);
  }
  return { idx, authStatus: null };
}
