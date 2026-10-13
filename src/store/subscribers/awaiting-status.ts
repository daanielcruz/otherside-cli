import {
  isAwaitingDecision,
  subscribeAwaitingDecision,
} from "@/kernel/channels/awaiting-decision.ts";
import { emitSessionStatus } from "@/kernel/channels/session-events.ts";

export function startAwaitingStatusSubscriber(): () => void {
  let wasAwaiting = false;

  return subscribeAwaitingDecision(() => {
    if (isAwaitingDecision()) {
      wasAwaiting = true;
      emitSessionStatus("awaiting");
    } else if (wasAwaiting) {
      wasAwaiting = false;
      emitSessionStatus("streaming");
    }
  });
}
