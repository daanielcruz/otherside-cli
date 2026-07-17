import { loadFreshAuth } from "@/backend/shared/auth.ts";
import { type Device, ensureDevice } from "@/backend/shared/device.ts";
import { encryptSessionMetadata, ensureSessionKey } from "@/backend/shared/session-crypto.ts";
import { type SessionStatus, subscribeSessionStatus } from "@/kernel/channels/session-events.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { getSessionTitle } from "@/store/session-title/index.ts";
import { patchSessionRow, sessionModelFields, upsertSessionRow } from "./session-api.ts";

export type SessionSyncStatus = SessionStatus;

let sessionSyncStatus: SessionSyncStatus = "idle";
let activeSyncSessionId: string | null = null;
// Whether the backend row for the active session exists (bootstrap done).
// Status/title PATCHes before registration match zero rows under RLS and
// "succeed" silently — suppressing them keeps the wire honest and lets the
// register payload carry the freshest local status instead.
let sessionRegistered = false;

export function getActiveSyncSessionId(): string | null {
  return activeSyncSessionId;
}

export function setActiveSyncSessionId(id: string | null): void {
  activeSyncSessionId = id;
  if (id === null) sessionRegistered = false;
}

export function setSessionRegistered(registered: boolean): void {
  sessionRegistered = registered;
}

export function getSessionSyncStatus(): SessionSyncStatus {
  return sessionSyncStatus;
}

function encryptedMetadata(
  sessionId: string,
  device: Device,
  field: "title" | "project" | "branch",
  plaintext: string,
) {
  return encryptSessionMetadata({
    sessionId,
    senderDeviceId: device.id,
    sessionKey: ensureSessionKey(sessionId),
    ratchet: new Map(),
    field,
    plaintext,
  });
}

export async function setSessionStatus(status: SessionSyncStatus): Promise<void> {
  sessionSyncStatus = status;
  const sessionId = activeSyncSessionId;
  if (!sessionId || !sessionRegistered) return;
  const auth = await loadFreshAuth();
  if (!auth) return;
  try {
    // Cortex owns updated_at/ended_at (derived from status) — a client-set
    // timestamp is rejected by the strict PATCH schema.
    await patchSessionRow(sessionId, auth.accessToken, { status });
  } catch {}
}

// The companion shows this as the session headline; the cwd + branch drop to a
// subline. Generated or resumed titles reach the backend through here.
export async function setSessionTitle(title: string): Promise<void> {
  const sessionId = activeSyncSessionId;
  if (!sessionId || !sessionRegistered) return;
  const auth = await loadFreshAuth();
  if (!auth) return;
  try {
    await patchSessionRow(sessionId, auth.accessToken, {
      title: encryptedMetadata(sessionId, ensureDevice(), "title", title),
    });
  } catch {}
}

subscribeSessionStatus((status) => {
  void setSessionStatus(status).catch(() => {});
});

export async function registerRemoteSession(
  device: Device,
  session: Session,
  broker: Broker,
  accessToken: string,
): Promise<void> {
  const project = session.cwd;
  const branch = session.gitBranch || null;
  const title = getSessionTitle();
  const body = {
    id: session.id,
    environment_id: device.id,
    ...sessionModelFields(broker),
    status: sessionSyncStatus,
    project: encryptedMetadata(session.id, device, "project", project),
    branch: branch ? encryptedMetadata(session.id, device, "branch", branch) : null,
    // Omit the title when absent so the upsert never clobbers a title the
    // backend already holds. Cortex owns identity and lifecycle columns —
    // user_id (from the JWT actor) and created_at/updated_at/deleted_at are
    // set server-side and rejected by the strict schema if sent here.
    ...(title ? { title: encryptedMetadata(session.id, device, "title", title) } : {}),
  };

  await upsertSessionRow(accessToken, body);
}
