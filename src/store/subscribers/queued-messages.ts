import { setQueuedMessageLookup, subscribeQueueDrain } from "@/kernel/channels/queued-messages.ts";
import { getQueueMessages, queueActions } from "@/store/queue-store/index.ts";

export function startQueuedMessageBridge(): () => void {
  setQueuedMessageLookup((id) => getQueueMessages().find((m) => m.id === id));
  return subscribeQueueDrain((result) => {
    for (const id of result.removedQueuedMessageIds) queueActions.removeById(id);
  });
}
