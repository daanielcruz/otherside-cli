import { subscribeRemoteInvalidated } from "@/kernel/channels/remote-sync.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startRemoteInvalidationSubscriber(): () => void {
  let epoch = 0;
  return subscribeRemoteInvalidated(() => {
    epoch += 1;
    dispatch({ type: "engine/setSlice", key: "remoteInvalidationEpoch", value: epoch });
  });
}

export function readRemoteInvalidationEpoch(engine: Readonly<Record<string, unknown>>): number {
  const value = engine.remoteInvalidationEpoch;
  return typeof value === "number" ? value : 0;
}
