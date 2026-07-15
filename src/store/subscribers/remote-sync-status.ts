import { getRemoteSyncStatus, subscribeRemoteSyncStatus } from "@/kernel/channels/remote-sync.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startRemoteSyncStatusSubscriber(): () => void {
  dispatch({ type: "view/setRemoteSyncStatus", status: getRemoteSyncStatus() });
  return subscribeRemoteSyncStatus((status) => {
    dispatch({ type: "view/setRemoteSyncStatus", status });
  });
}
