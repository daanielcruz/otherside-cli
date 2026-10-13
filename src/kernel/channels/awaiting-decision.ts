import { peek as peekQuestion, subscribe as subscribeQuestions } from "@/kernel/channels/ask.ts";
import {
  peek as peekPermission,
  subscribe as subscribePermissions,
} from "@/kernel/channels/permission.ts";

/**
 * Whether the session is held on the reader: a permission to grant or a question to
 * answer. The one predicate every surface asks, so the session status and the frame
 * never disagree about when a decision is open.
 */
export function isAwaitingDecision(): boolean {
  return peekPermission() !== null || peekQuestion() !== null;
}

/** Calls `listener` whenever a permission or a question opens or closes. */
export function subscribeAwaitingDecision(listener: () => void): () => void {
  const unsubscribePermissions = subscribePermissions(listener);
  const unsubscribeQuestions = subscribeQuestions(listener);
  return () => {
    unsubscribePermissions();
    unsubscribeQuestions();
  };
}
