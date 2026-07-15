import type { Broker, Session } from "@/kernel/std/types/session.ts";
import { ensureDevice } from "@/remote/devices/device.ts";
import { listPeers, syncPeersWithBackend } from "@/remote/devices/peers.ts";
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
