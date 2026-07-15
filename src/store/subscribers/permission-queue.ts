import { type PendingPermission, subscribe } from "@/kernel/channels/permission.ts";
import { dispatch } from "@/store/app-store/index.ts";

export function startPermissionQueueSubscriber(): () => void {
  return subscribe((queue) => {
    dispatch({ type: "engine/setSlice", key: "permissionQueue", value: queue });
  });
}

export function readPermissionQueueSlice(
  engine: Readonly<Record<string, unknown>>,
): PendingPermission[] | undefined {
  const value = engine.permissionQueue;
  if (value === undefined) return undefined;
  return value as PendingPermission[];
}
