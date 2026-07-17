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
  last_synced_index?: number;
  // Legacy single-record claim shape; migrated to pending_counters on next claim.
  pending_counter?: { index: number; counter: number };
  pending_counters?: { start_index: number; counters: number[] };
}

export interface HttpError extends Error {
  httpStatus: number;
}

export type DeliveryResult =
  | { kind: "delivered" }
  | { kind: "duplicate" }
  | { kind: "rejected"; detail: string }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "retryable" };

// PostgREST reports both unique (23505) and foreign-key (23503) violations as
// HTTP 409. Only a unique violation on (session_id, sender_device_id, counter)
// means the row already landed — anything else (e.g. the sessions row is
// missing, or owned
// by another account after an account switch) must never pass as a delivered
// duplicate, or the synced index advances over events that never inserted.
const UNIQUE_VIOLATION = "23505";
// With RLS enabled the missing/foreign sessions row usually surfaces BEFORE
// the FK: the insert with-check fails as 403 + 42501 (live-probed). That 403
// is a row-level refusal, not a dead token — it must classify as rejected so
// the sync re-bootstraps instead of suspending the pairing as unauthorized.
const RLS_VIOLATION = "42501";

async function responseCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string; error_code?: string };
    if (typeof body.code === "string" && body.code.length > 0) return body.code;
    if (typeof body.error_code === "string" && body.error_code.length > 0) {
      // Map cortex codes onto legacy PostgREST codes expected by callers.
      if (body.error_code === "conflict" || body.error_code === "replay_detected") return "23505";
      if (body.error_code === "forbidden") return "42501";
      return body.error_code;
    }
    return "";
  } catch {
    return "";
  }
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
    data = { key_b64: b64uEncode(generateSessionKey()), counter: 0, last_synced_index: 0 };
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

function pendingClaim(data: SessionKeyData): { start_index: number; counters: number[] } | null {
  if (data.pending_counters) return data.pending_counters;
  if (data.pending_counter) {
    return { start_index: data.pending_counter.index, counters: [data.pending_counter.counter] };
  }
  return null;
}

// A record keeps its first allocated counter across retries, so an ambiguous
// failure (rows inserted but response lost) replays as the exact same rows and
// resolves as a 409 duplicate instead of inserting a second copy. A request
// fully covered by the pending claim never rewrites it — a partial serial
// retry inside a claimed batch must not drop claims for its later records.
export function claimOutgoingCounters(
  sessionId: string,
  startIndex: number,
  count: number,
): number[] {
  const data = readOrCreateSessionKeyData(sessionId);
  const pending = pendingClaim(data);
  const counters: number[] = [];
  if (pending) {
    const offset = startIndex - pending.start_index;
    if (offset >= 0 && offset < pending.counters.length) {
      counters.push(...pending.counters.slice(offset, offset + count));
    }
    if (counters.length >= count) return counters;
  }
  while (counters.length < count) {
    data.counter += 1;
    counters.push(data.counter);
  }
  data.pending_counters = { start_index: startIndex, counters };
  delete data.pending_counter;
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

export function httpError(status: number, detail: string): HttpError {
  return Object.assign(new Error(`HTTP ${status} - ${detail}`), { httpStatus: status });
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
      const status =
        err.code === "conflict" || err.code === "replay_detected"
          ? 409
          : err.code === "unauthorized"
            ? 401
            : err.code === "forbidden"
              ? 403
              : err.httpStatus || 500;
      const code =
        err.code === "conflict" || err.code === "replay_detected"
          ? "23505"
          : err.code === "forbidden"
            ? "42501"
            : err.code;
      return new Response(JSON.stringify({ message: err.message, code, error_code: err.code }), {
        status,
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
    if (code === UNIQUE_VIOLATION) return { kind: "duplicate" };
    return { kind: "rejected", detail: code || "conflict" };
  }
  if (response.status === 403) {
    const code = await responseCode(response);
    if (code === RLS_VIOLATION) return { kind: "rejected", detail: code };
    return { kind: "auth", status: 403 };
  }
  if (response.status === 401) {
    return { kind: "auth", status: 401 };
  }
  return { kind: "retryable" };
}

// PostgREST array inserts are atomic: 201 means every row landed, 409 means
// the whole batch was rejected because at least one row already exists. The
// backend's counter guard is a partial unique index (counter is not null),
// which on_conflict cannot target, so `resolution=ignore-duplicates` is not
// an option — the caller resolves a conflict by re-sending row by row.
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
    if (code === UNIQUE_VIOLATION) return { kind: "conflict" };
    return { kind: "rejected", detail: code || "conflict" };
  }
  if (response.status === 403) {
    const code = await responseCode(response);
    if (code === RLS_VIOLATION) return { kind: "rejected", detail: code };
    return { kind: "auth", status: 403 };
  }
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

export function loadSyncedIndex(sessionId: string): number | null {
  const data = readOrCreateSessionKeyData(sessionId);
  return data.last_synced_index ?? null;
}

export function persistSyncedIndex(sessionId: string, index: number): void {
  const data = readOrCreateSessionKeyData(sessionId);
  if (data.last_synced_index !== index) {
    data.last_synced_index = index;
    writeFileSecure(sessionKeyPath(sessionId), JSON.stringify(data, null, 2), 0o600);
  }
}
