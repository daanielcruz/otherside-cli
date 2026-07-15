import { subscribe as subscribeAsk } from "@/kernel/channels/ask.ts";
import { subscribe as subscribePermission } from "@/kernel/channels/permission.ts";
import { emitSessionStatus } from "@/kernel/channels/session-events.ts";

export function startAwaitingStatusSubscriber(): () => void {
  let permissionPending = false;
  let askPending = false;
  let wasAwaiting = false;

  function publish(): void {
    const isAwaiting = permissionPending || askPending;
    if (isAwaiting) {
      wasAwaiting = true;
      emitSessionStatus("awaiting");
    } else if (wasAwaiting) {
      wasAwaiting = false;
      emitSessionStatus("streaming");
    }
  }

  const unsubPerm = subscribePermission((queue) => {
    permissionPending = queue.length > 0;
    publish();
  });
  const unsubAsk = subscribeAsk((queue) => {
    askPending = queue.length > 0;
    publish();
  });

  return () => {
    unsubPerm();
    unsubAsk();
  };
}
