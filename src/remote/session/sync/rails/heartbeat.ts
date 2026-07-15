import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { decodeUserId, loadFreshAuth } from "@/remote/backend/auth.ts";
import type { Device } from "@/remote/devices/device.ts";
import { getSessionRow, patchSessionRow, sessionModelFields } from "../session-api.ts";
import { getActiveSyncSessionId, registerRemoteSession } from "../session-status.ts";

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
    const res = await getSessionRow(sessionId, auth.accessToken, "id,deleted_at");
    if (!res.ok) return;
    const data = (await res.json()) as { id: string; deleted_at: string | null }[];

    if (data.length === 0 || data[0]?.deleted_at !== null) {
      const userId = decodeUserId(auth.accessToken);
      if (userId) {
        await registerRemoteSession(device, session, broker, userId, auth.accessToken);
      }
      return;
    }

    await patchSessionRow(sessionId, auth.accessToken, {
      updated_at: new Date().toISOString(),
      ...sessionModelFields(broker),
    });
  } catch {}
}
