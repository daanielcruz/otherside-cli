import type { Broker } from "@/store/app-store/broker.ts";
import { startAwaitingStatusSubscriber } from "@/store/subscribers/awaiting-status.ts";
import { startBrokerSubscriber } from "@/store/subscribers/broker.ts";
import { startPermissionQueueSubscriber } from "@/store/subscribers/permission-queue.ts";
import { startRemoteInvalidationSubscriber } from "@/store/subscribers/remote-invalidation.ts";
import { startRemoteSyncStatusSubscriber } from "@/store/subscribers/remote-sync-status.ts";
import { startTerminalProgressSubscriber } from "@/store/subscribers/terminal-progress.ts";
import { startUsageLimitsSubscriber } from "@/store/subscribers/usage-limits.ts";
import { startWorkflowTasksSubscriber } from "@/store/subscribers/workflow-tasks.ts";

export interface BootCtx {
  readonly broker: Broker;
}

export function bootSubscribers(ctx: BootCtx): () => void {
  const disposers: Array<() => void> = [
    startBrokerSubscriber(ctx.broker),
    startUsageLimitsSubscriber(ctx.broker),
    startRemoteSyncStatusSubscriber(),
    startAwaitingStatusSubscriber(),
    startPermissionQueueSubscriber(),
    startWorkflowTasksSubscriber(),
    startRemoteInvalidationSubscriber(),
    startTerminalProgressSubscriber(),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export { startAwaitingStatusSubscriber } from "@/store/subscribers/awaiting-status.ts";
export { readBrokerSlice, startBrokerSubscriber } from "@/store/subscribers/broker.ts";
export {
  readPermissionQueueSlice,
  startPermissionQueueSubscriber,
} from "@/store/subscribers/permission-queue.ts";
export {
  readRemoteInvalidationEpoch,
  startRemoteInvalidationSubscriber,
} from "@/store/subscribers/remote-invalidation.ts";
export { startRemoteSyncStatusSubscriber } from "@/store/subscribers/remote-sync-status.ts";
export { startTerminalProgressSubscriber } from "@/store/subscribers/terminal-progress.ts";
export {
  readUsageLimitSnapshotSlice,
  startUsageLimitsSubscriber,
} from "@/store/subscribers/usage-limits.ts";
export {
  readWorkflowTasksSlice,
  startWorkflowTasksSubscriber,
} from "@/store/subscribers/workflow-tasks.ts";
