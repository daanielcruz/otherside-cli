import {
  notifyPermissionContextChanged,
  type PendingPermission,
  subscribe,
} from "@/kernel/channels/permission.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startPermissionQueueSubscriber(): () => void {
  return subscribe((queue) => {
    dispatch({ type: "engine/setSlice", key: "permissionQueue", value: queue });
  });
}

/** A permission-mode change can settle prompts that are already waiting. */
export function startPermissionModeSubscriber(broker: Broker): () => void {
  return broker.select((state) => state.permissionMode, notifyPermissionContextChanged);
}

export function readPermissionQueueSlice(
  engine: Readonly<Record<string, unknown>>,
): PendingPermission[] | undefined {
  const value = engine.permissionQueue;
  if (value === undefined) return undefined;
  return value as PendingPermission[];
}
