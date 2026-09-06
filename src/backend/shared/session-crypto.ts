import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CortexApiError, cortexFetch } from "@/backend/shared/cortex.ts";
import type { Device } from "@/backend/shared/device.ts";
import {
  b64uDecode,
  b64uEncode,
  encryptEvent,
  generateSessionKey,
  ratchetStep,
  ratchetTo,
} from "@/backend/shared/e2ee.ts";
import { remoteHome } from "@/backend/shared/paths.ts";
import { mkdirSecure, writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import type { Session } from "@/kernel/std/types/session.ts";

const ENC = new TextEncoder();

export interface RatchetCacheEntry {
  // counter -> derived key checkpoints, insertion-ordered for cheap eviction
  checkpoints: Map<number, Uint8Array>;
}

interface SessionKeyData {
  key_b64: string;
  counter: number;
  remote_deleted?: boolean;
  // The last record this device delivered, named by its transcript uuid. A uuid
  // survives the record array being rebuilt or trimmed on resume, which a
  // position does not: a position silently addresses a different record once
  // the array in front of it changes length.
  last_synced_uuid?: string | null;
  // Counters already minted for a batch, named record by record so a serial
  // retry that resumes mid-batch still finds its own counter.
  pending_claim?: { uuids: (string | null)[]; counters: number[] };
  // Position-addressed cursor and claim. Read once by migrateSyncCursor while
  // the array still has the shape they were written against, then dropped.
  last_synced_index?: number;
  pending_counter?: { index: number; counter: number };
  pending_counters?: { start_index: number; counters: number[] };
}

export interface HttpError extends Error {
  httpStatus: number;
  errorCode?: string;
}

export type DeliveryResult =
  | { kind: "delivered" }
  | { kind: "duplicate" }
  | { kind: "rejected"; detail: string }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "retryable" };

const DUPLICATE_EVENT_CODE = "replay_detected";
const ROW_FORBIDDEN_CODE = "forbidden";
export const SESSION_NOT_FOUND_CODE = "not_found";
export const SESSION_DELETED_CODE = "session_deleted";

async function responseCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string; error_code?: string };
    if (typeof body.code === "string" && body.code.length > 0) return body.code;
    if (typeof body.error_code === "string" && body.error_code.length > 0) {
      return body.error_code;
    }
    return "";
  } catch {
    return "";
  }
}

async function missingSessionCode(response: Response): Promise<string | null> {
  if (response.status !== 404 && response.status !== 410) return null;
  const code = await responseCode(response);
  return code || (response.status === 410 ? SESSION_DELETED_CODE : SESSION_NOT_FOUND_CODE);
}

const counterCache = new Map<string, SessionKeyData>();

function sessionKeyPath(sessionId: string): string {
  return join(remoteHome(), "session_keys", `${sessionId}.json`);
}

function readOrCreateSessionKeyData(sessionId: string): SessionKeyData {
  const cached = counterCache.get(sessionId);
  if (cached) return cached;
  const path = sessionKeyPath(sessionId);
  let data: SessionKeyData | null = null;
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as SessionKeyData;
    } catch {}
  }
  if (!data) {
    data = { key_b64: b64uEncode(generateSessionKey()), counter: 0, last_synced_uuid: null };
    mkdirSecure(dirname(path), 0o700);
    writeFileSecure(path, JSON.stringify(data, null, 2), 0o600);
  }
  counterCache.set(sessionId, data);
  return data;
}

export function ensureSessionKey(sessionId: string): Uint8Array {
  return b64uDecode(readOrCreateSessionKeyData(sessionId).key_b64);
}

export function incrementCounter(sessionId: string): number {
  const data = readOrCreateSessionKeyData(sessionId);
  data.counter += 1;
  writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
  return data.counter;
}

export type SessionMetadataField = "title" | "project" | "branch";

// Metadata shares the session-event ratchet and its AD binding. A row carries
// the resulting envelope opaquely, while every paired device already holding
// the session key can derive the same per-counter key to open it.
export function encryptSessionMetadata(args: {
  sessionId: string;
  senderDeviceId: string;
  sessionKey: Uint8Array;
  ratchet: Map<string, RatchetCacheEntry>;
  field: SessionMetadataField;
  plaintext: string;
}): ReturnType<typeof encryptEvent> {
  const counter = incrementCounter(args.sessionId);
  const ratchetKey = ratchetKeyFor(args.ratchet, args.sessionKey, args.senderDeviceId, counter);
  return encryptEvent({
    ratchetKey,
    sessionId: args.sessionId,
    eventType: `session_metadata/${args.field}`,
    senderDeviceId: args.senderDeviceId,
    counter,
    plaintext: ENC.encode(args.plaintext),
  });
}

/**
 * Where a batch's first record sits inside the pending claim, or null when the
 * claim cannot be aligned to it.
 *
 * Alignment reads the first record that carries a name and subtracts its
 * position in the batch. An unnamed record has no identity to match on, but
 * its offset from a named sibling in the same batch does — so only a batch
 * with no named record at all is unmatchable. Such a batch is never matched on
 * shape alone: two of them are indistinguishable, and reusing counters that
 * were already accepted would make the resend read as a replay and drop those
 * rows rather than deliver them.
 */
function claimAlignment(
  pending: { uuids: (string | null)[] },
  uuids: (string | null)[],
): number | null {
  for (let i = 0; i < uuids.length; i++) {
    const uuid = uuids[i];
    if (uuid === null || uuid === undefined) continue;
    const found = pending.uuids.indexOf(uuid);
    return found >= i ? found - i : null;
  }
  return null;
}

// A record keeps its first allocated counter across retries, so an ambiguous
// failure (rows inserted but response lost) replays as the exact same rows and
// the broker answers replay_detected instead of inserting a second copy.
// Counters are unique per session and sending device, so a fresh counter is
// always a new row and never deduplicates — reusing the claim is what makes a
// retry safe. The claim names each record, so a serial retry that resumes in
// the middle of a batch still finds its own counter.
export function claimOutgoingCounters(sessionId: string, uuids: (string | null)[]): number[] {
  const data = readOrCreateSessionKeyData(sessionId);
  const pending = data.pending_claim;
  const offset = pending ? claimAlignment(pending, uuids) : null;
  const counters: number[] = [];
  if (pending && offset !== null) {
    counters.push(...pending.counters.slice(offset, offset + uuids.length));
    if (counters.length >= uuids.length) return counters;
  }
  while (counters.length < uuids.length) {
    data.counter += 1;
    counters.push(data.counter);
  }
  // A claim holding no name could never be aligned again, so it is not kept.
  if (uuids.some((uuid) => uuid !== null && uuid !== undefined)) {
    data.pending_claim = { uuids, counters };
  } else {
    delete data.pending_claim;
  }
  writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
  return counters;
}

// Covers the incoming reorder window (16) with headroom, so a late event only
// pays HKDF steps from the nearest checkpoint instead of the whole chain.
const RATCHET_CHECKPOINTS = 32;

export function ratchetKeyFor(
  cache: Map<string, RatchetCacheEntry>,
  sessionKey: Uint8Array,
  senderId: string,
  counter: number,
): Uint8Array {
  let entry = cache.get(senderId);
  if (!entry) {
    entry = { checkpoints: new Map() };
    cache.set(senderId, entry);
  }
  const cached = entry.checkpoints.get(counter);
  if (cached) return cached;
  let baseCounter = 0;
  let baseKey = sessionKey;
  for (const [c, k] of entry.checkpoints) {
    if (c <= counter && c > baseCounter) {
      baseCounter = c;
      baseKey = k;
    }
  }
  const key =
    baseCounter === 0 ? ratchetTo(sessionKey, counter) : ratchetStep(baseKey, baseCounter, counter);
  entry.checkpoints.set(counter, key);
  if (entry.checkpoints.size > RATCHET_CHECKPOINTS) {
    const oldest = entry.checkpoints.keys().next().value;
    if (oldest !== undefined) entry.checkpoints.delete(oldest);
  }
  return key;
}

export function httpError(status: number, detail: string, errorCode?: string): HttpError {
  return Object.assign(new Error(`HTTP ${status} - ${detail}`), {
    httpStatus: status,
    ...(errorCode ? { errorCode } : {}),
  });
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof Error && "httpStatus" in err && typeof err.httpStatus === "number";
}

export function authFailureStatus(status: number): 401 | 403 | null {
  if (status === 401) return 401;
  if (status === 403) return 403;
  return null;
}

export async function postSessionEvent(
  accessToken: string,
  body: Record<string, unknown> | Record<string, unknown>[],
): Promise<Response> {
  const rows = Array.isArray(body) ? body : [body];
  const sessionId = String(rows[0]?.session_id ?? "");
  if (!sessionId) {
    return new Response(JSON.stringify({ message: "missing session_id" }), { status: 400 });
  }
  try {
    const data = await cortexFetch<{ inserted?: number; ids?: string[] }>(
      `/v1/sessions/${sessionId}/events`,
      {
        method: "POST",
        token: accessToken,
        body: {
          sender_device_id: rows[0]?.sender_device_id,
          events: rows.map((r) => ({
            type: r.type,
            payload: r.payload,
            counter: r.counter,
            id: r.id,
          })),
        },
        idempotencyKey: crypto.randomUUID(),
      },
    );
    return new Response(JSON.stringify(data), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (err instanceof CortexApiError) {
      return new Response(JSON.stringify({ message: err.message, error_code: err.code }), {
        status: err.httpStatus || 500,
        headers: { "content-type": "application/json" },
      });
    }
    throw err;
  }
}

export async function sendEncryptedEvent(deps: {
  device: Device;
  session: Session;
  userId: string;
  accessToken: string;
  sessionKey: Uint8Array;
  ratchet: Map<string, RatchetCacheEntry>;
  eventType: string;
  plaintext: string;
  counter?: number;
}): Promise<DeliveryResult> {
  const { device, session, userId, accessToken, sessionKey, ratchet, eventType, plaintext } = deps;
  const counter = deps.counter ?? incrementCounter(session.id);
  const ratchetKey = ratchetKeyFor(ratchet, sessionKey, device.id, counter);
  const envelope = encryptEvent({
    ratchetKey,
    sessionId: session.id,
    eventType,
    senderDeviceId: device.id,
    counter,
    plaintext: ENC.encode(plaintext),
  });
  const response = await postSessionEvent(accessToken, {
    session_id: session.id,
    user_id: userId,
    type: eventType,
    payload: envelope,
    counter,
    sender_device_id: device.id,
  });
  if (response.ok) {
    return { kind: "delivered" };
  }
  if (response.status === 409) {
    const code = await responseCode(response);
    if (code === DUPLICATE_EVENT_CODE) return { kind: "duplicate" };
    return { kind: "rejected", detail: code || "conflict" };
  }
  if (response.status === 403) {
    const code = await responseCode(response);
    if (code === ROW_FORBIDDEN_CODE) return { kind: "rejected", detail: code };
    return { kind: "auth", status: 403 };
  }
  const missingCode = await missingSessionCode(response);
  if (missingCode) return { kind: "rejected", detail: missingCode };
  if (response.status === 401) {
    return { kind: "auth", status: 401 };
  }
  return { kind: "retryable" };
}

// Batch inserts are atomic. A duplicate counter rejects the batch, so the
// caller resends rows individually to advance past already-delivered events.
export type BatchDeliveryResult =
  | { kind: "delivered" }
  | { kind: "conflict" }
  | { kind: "rejected"; detail: string }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "retryable" };

export async function sendEncryptedEventBatch(deps: {
  device: Device;
  session: Session;
  userId: string;
  accessToken: string;
  sessionKey: Uint8Array;
  ratchet: Map<string, RatchetCacheEntry>;
  items: Array<{ eventType: string; plaintext: string; counter: number }>;
}): Promise<BatchDeliveryResult> {
  const { device, session, userId, accessToken, sessionKey, ratchet, items } = deps;
  const rows = items.map((item) => {
    const ratchetKey = ratchetKeyFor(ratchet, sessionKey, device.id, item.counter);
    const envelope = encryptEvent({
      ratchetKey,
      sessionId: session.id,
      eventType: item.eventType,
      senderDeviceId: device.id,
      counter: item.counter,
      plaintext: ENC.encode(item.plaintext),
    });
    return {
      session_id: session.id,
      user_id: userId,
      type: item.eventType,
      payload: envelope,
      counter: item.counter,
      sender_device_id: device.id,
    };
  });
  const response = await postSessionEvent(accessToken, rows);
  if (response.ok) {
    return { kind: "delivered" };
  }
  if (response.status === 409) {
    const code = await responseCode(response);
    if (code === DUPLICATE_EVENT_CODE) return { kind: "conflict" };
    return { kind: "rejected", detail: code || "conflict" };
  }
  if (response.status === 403) {
    const code = await responseCode(response);
    if (code === ROW_FORBIDDEN_CODE) return { kind: "rejected", detail: code };
    return { kind: "auth", status: 403 };
  }
  const missingCode = await missingSessionCode(response);
  if (missingCode) return { kind: "rejected", detail: missingCode };
  if (response.status === 401) {
    return { kind: "auth", status: 401 };
  }
  return { kind: "retryable" };
}

// Whether the backend still accepts this token at all. Separates "the token
// died" from "the token is fine but a specific row is not ours": a bootstrap
// 403 on a session owned by another account must not be treated as an auth
// failure, or the client wrongly invalidates its whole pairing.
export async function probeAuth(accessToken: string): Promise<boolean | null> {
  try {
    await cortexFetch("/v1/environments", { method: "GET", token: accessToken });
    return true;
  } catch (err) {
    if (err instanceof CortexApiError) {
      if (err.code === "unauthorized" || err.code === "forbidden") return false;
      return null;
    }
    return null;
  }
}

/** The uuid of the last record delivered to the broker, or null for none. */
export function loadSyncedAnchor(sessionId: string): string | null {
  return readOrCreateSessionKeyData(sessionId).last_synced_uuid ?? null;
}

export function persistSyncedAnchor(sessionId: string, uuid: string | null): void {
  const data = readOrCreateSessionKeyData(sessionId);
  if ((data.last_synced_uuid ?? null) === uuid) return;
  data.last_synced_uuid = uuid;
  writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
}

/**
 * Convert a position-addressed cursor and claim to the uuids they named.
 *
 * **Precondition, and it cannot be checked here: `uuidAt` must address the same
 * record array those positions were written against.** A position carries no
 * evidence of the array it came from, so converting it against a different one
 * yields an anchor naming the wrong record — and a wrong anchor resolves
 * cleanly, which is the silent failure this cursor exists to prevent.
 *
 * The obligation therefore falls on the caller. While the record set is built
 * by replaying the transcript, adopting the cursor at session start satisfies
 * it. **Once the record set is built from aggregates rather than replayed,
 * that no longer holds and the legacy field must be DROPPED rather than
 * converted** — a full resend costs duplicate rows on the companion, where a
 * mis-converted anchor costs records it never receives at all.
 *
 * `uuidAt` answers with the uuid of the record at one position, or null when
 * that record carries none. Runs at most once per session: the positions leave
 * the file on the same write, so a later array has nothing left to misread.
 */
export function migrateSyncCursor(
  sessionId: string,
  uuidAt: (index: number) => string | null,
  options: { positionsResolve?: boolean } = {},
): void {
  const positionsResolve = options.positionsResolve ?? true;
  const data = readOrCreateSessionKeyData(sessionId);
  const legacyClaim =
    data.pending_counters ??
    (data.pending_counter
      ? { start_index: data.pending_counter.index, counters: [data.pending_counter.counter] }
      : null);
  if (data.last_synced_index === undefined && legacyClaim === null) return;

  // Positions that no longer resolve are dropped unconverted, leaving no anchor
  // at all. That resends the session, which costs duplicate rows; converting one
  // against an array it was not measured against yields an anchor naming the
  // wrong record, and that resolves cleanly while costing records outright.
  if (
    positionsResolve &&
    data.last_synced_index !== undefined &&
    data.last_synced_uuid === undefined
  ) {
    // The cursor counts records consumed, so the record it named sits one back.
    // Non-syncable lines carry no uuid, so walk back to the nearest that does:
    // resuming just after it can only re-offer lines the encoder skips anyway.
    let anchor: string | null = null;
    for (let i = data.last_synced_index - 1; i >= 0 && anchor === null; i--) {
      anchor = uuidAt(i);
    }
    data.last_synced_uuid = anchor;
  }
  if (positionsResolve && legacyClaim !== null && data.pending_claim === undefined) {
    data.pending_claim = {
      uuids: legacyClaim.counters.map((_, i) => uuidAt(legacyClaim.start_index + i)),
      counters: legacyClaim.counters,
    };
  }
  delete data.last_synced_index;
  delete data.pending_counter;
  delete data.pending_counters;
  writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
}

export function hasRemoteDeletionMarker(sessionId: string): boolean {
  return readOrCreateSessionKeyData(sessionId).remote_deleted === true;
}

export function persistRemoteDeletionMarker(sessionId: string): void {
  const data = readOrCreateSessionKeyData(sessionId);
  if (data.remote_deleted === true) return;
  data.remote_deleted = true;
  writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
}
