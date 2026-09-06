import {
  getSessionRow,
  patchSessionRow,
  sessionModelFields,
} from "@/backend/app/session/sync/session-api.ts";
import {
  getActiveSyncSessionId,
  registerRemoteSession,
} from "@/backend/app/session/sync/session-status.ts";
import { loadFreshAuth } from "@/backend/shared/auth.ts";
import type { Device } from "@/backend/shared/device.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";

export async function sendHeartbeat(
  device: Device,
  session: Session,
  broker: Broker,
): Promise<void> {
  const sessionId = getActiveSyncSessionId();
  if (!sessionId) return;
  const auth = await loadFreshAuth();
  if (!auth) return;
  try {
    // Cortex returns 404 for a purged/ended row and 200 for a live one, so the
    // status code — not a deleted_at column — decides whether to recreate.
    const res = await getSessionRow(sessionId, auth.accessToken, "id");
    if (res.status === 404) {
      await registerRemoteSession(device, session, broker, auth.accessToken);
      return;
    }
    if (!res.ok) return;
    // Row is live — refresh model/status; cortex owns updated_at.
    await patchSessionRow(sessionId, auth.accessToken, {
      ...sessionModelFields(broker),
    });
  } catch {}
}
