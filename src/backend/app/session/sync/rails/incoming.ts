import { buildIncomingMessage } from "@/backend/app/session/inbound.ts";
import { applyAskResponse } from "@/backend/app/session/sync/ask-response.ts";
import { CortexApiError, cortexFetch } from "@/backend/shared/cortex.ts";
import type { Device } from "@/backend/shared/device.ts";
import { decryptEvent } from "@/backend/shared/e2ee.ts";
import {
  authFailureStatus,
  type RatchetCacheEntry,
  ratchetKeyFor,
} from "@/backend/shared/session-crypto.ts";
import {
  answer as answerPermission,
  find as findPendingPermission,
  type PendingPermission,
  PermissionResults,
} from "@/kernel/channels/permission.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";

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
        kind: "set_route",
        route: { provider: modelChange.provider as ProviderId, model: modelChange.model },
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
}): Promise<401 | 403 | 404 | 410 | null> {
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
      if (err.code === "session_deleted" || err.httpStatus === 410) return 410;
      if (err.code === "not_found" || err.httpStatus === 404) return 404;
      return authFailureStatus(err.httpStatus || (err.code === "unauthorized" ? 401 : 0));
    }
    return null;
  }
}
