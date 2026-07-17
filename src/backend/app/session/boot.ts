import { listPeers, syncPeersWithBackend } from "@/backend/app/peers.ts";
import { ensureDevice } from "@/backend/shared/device.ts";
import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { isAutoEnable, isRemoteEnabled, setRemoteEnabled } from "./state.ts";
import { type SyncHandle, startSync } from "./sync.ts";

export async function bootRemote(session: Session, broker: Broker): Promise<SyncHandle | null> {
  try {
    await syncPeersWithBackend();
    setRemoteEnabled(isAutoEnable());
    if (!isRemoteEnabled()) return null;
    if (listPeers().length === 0) return null;
    return await startSync(ensureDevice(), session, broker);
  } catch {
    return null;
  }
}
