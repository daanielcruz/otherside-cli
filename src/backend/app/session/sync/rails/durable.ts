import type { Device } from "@/backend/shared/device.ts";
import {
  claimOutgoingCounters,
  type RatchetCacheEntry,
  sendEncryptedEvent,
  sendEncryptedEventBatch,
} from "@/backend/shared/session-crypto.ts";
import { listBackgroundTasks } from "@/kernel/channels/background-tasks.ts";
import { getDisplayPath } from "@/kernel/std/fs/paths.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { Session } from "@/kernel/std/types/session.ts";
import { anchorUuid, commitSyncedThrough, type SyncCursor } from "../cursor.ts";

export {
  applyIncomingEvent,
  applyIncomingRow,
  type CancelQueuedMessageHandler,
  type IncomingRowDeps,
  type IncomingSyncState,
  isCounterAcceptable,
  isSyncableEvent,
  type QueuedMessageHandler,
  syncIncomingEvents,
} from "./incoming.ts";

function toResultBase(result: unknown): Record<string, unknown> {
  if (typeof result === "string") return { content: result };
  if (typeof result === "object" && result !== null) return result as Record<string, unknown>;
  return {};
}

function richResultForSync(result: unknown, meta: ToolResultMeta): Record<string, unknown> {
  const { kind: _kind, ...rest } = meta;
  return { content: typeof result === "string" ? result : "", ...rest };
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
  // Sidechain (subagent/fork) records stay out of the remote stream — the app
  // tracks agent work through the Agent tool card and tasks_update channel.
  if ("isSidechain" in r && r.isSidechain === true) return null;

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
  // How much of the array is delivered so far. The caller holds it and hands
  // it back on the next push.
  cursor: SyncCursor;
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
  cursor: SyncCursor;
}): Promise<OutgoingSyncResult> {
  const { device, session, userId, accessToken, sessionKey, ratchet, fromIndex } = deps;
  let cursor = deps.cursor;

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
          return { idx: item.index, cursor, authStatus: result.status };
        }
        if (result.kind === "rejected") {
          return { idx: item.index, cursor, authStatus: null, rejected: result.detail };
        }
        if (result.kind === "retryable") {
          return { idx: item.index, cursor, authStatus: null, retryable: true };
        }
      } catch {
        return { idx: item.index, cursor, authStatus: null, retryable: true };
      }
      // Persist per delivered event on this path: a crash mid-way must not
      // rewind the cursor behind rows the server already accepted.
      cursor = commitSyncedThrough(session, item.index + 1, cursor);
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
    // Gather a contiguous run of syncable records. The claim names each one,
    // so a serial retry that resumes mid-batch still finds its own counter.
    const encoded = [{ index: idx, ...first }];
    while (encoded.length < OUTBOX_BATCH_LIMIT && idx + encoded.length < session.records.length) {
      const next = encodeOutgoingRecord(session, idx + encoded.length);
      if (!next) break;
      encoded.push({ index: idx + encoded.length, ...next });
    }
    const counters = claimOutgoingCounters(
      session.id,
      encoded.map((item) => anchorUuid(session.records[item.index])),
    );
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
      return { idx, cursor, authStatus: null, retryable: true };
    }
    if (batchResult.kind === "auth") {
      return { idx, cursor, authStatus: batchResult.status };
    }
    if (batchResult.kind === "rejected") {
      return { idx, cursor, authStatus: null, rejected: batchResult.detail };
    }
    if (batchResult.kind === "retryable") {
      return { idx, cursor, authStatus: null, retryable: true };
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
    cursor = commitSyncedThrough(session, idx, cursor);
  }
  return { idx, cursor, authStatus: null };
}
