import { type SessionStatus, subscribeSessionStatus } from "@/kernel/channels/session-events.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { loadFreshAuth } from "@/remote/backend/auth.ts";
import type { Device } from "@/remote/devices/device.ts";
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

export async function setSessionStatus(status: SessionSyncStatus): Promise<void> {
  sessionSyncStatus = status;
  const sessionId = activeSyncSessionId;
  if (!sessionId || !sessionRegistered) return;
  const auth = await loadFreshAuth();
  if (!auth) return;
  try {
    await patchSessionRow(sessionId, auth.accessToken, {
      status,
      updated_at: new Date().toISOString(),
      ...(status === "ended" ? { ended_at: new Date().toISOString() } : {}),
    });
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
      title,
      updated_at: new Date().toISOString(),
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
  userId: string,
  accessToken: string,
): Promise<void> {
  const project = session.cwd;
  const branch = session.gitBranch || null;
  const title = getSessionTitle();
  const body = {
    id: session.id,
    user_id: userId,
    environment_id: device.id,
    ...sessionModelFields(broker),
    status: sessionSyncStatus,
    project,
    branch,
    // Omit when absent so the upsert never clobbers a title the backend
    // already holds with null on a title-less reconnect.
    ...(title ? { title } : {}),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };

  await upsertSessionRow(accessToken, body);
}
