import { useSyncExternalStore } from "react";
import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { PendingChange } from "@/store/app-store/actions.ts";

export interface QueuedPastedImage {
  id: number;
  data: string;
  mediaType: string;
  localPath?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  expanded: string;
  blocks?: ContentBlock[];
  pastedImages?: QueuedPastedImage[];
  remotePayload?: unknown;
  pendingChange?: PendingChange;
  recallText?: string;
  changeFeedback?: string;
}

export interface QueueState {
  readonly messages: readonly QueuedMessage[];
}

const initial: QueueState = { messages: [] };

export const queueStore: Store<QueueState> = makeStore<QueueState>(initial);

export function getQueueMessages(): readonly QueuedMessage[] {
  return queueStore.getState().messages;
}

export function queueIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const value = record.queueId ?? record.queue_id ?? record.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function removeFirstQueuedText(
  queue: readonly QueuedMessage[],
  text: string,
): readonly QueuedMessage[] {
  let removed = false;
  return queue.filter((q) => {
    const matches = q.expanded === text || q.text === text;
    if (!matches || removed) return true;
    removed = true;
    return false;
  });
}

export const queueActions = {
  push(msg: QueuedMessage): void {
    queueStore.setState((prev) => ({ messages: [...prev.messages, msg] }));
  },
  pushUnique(msg: QueuedMessage): void {
    queueStore.setState((prev) =>
      prev.messages.some((q) => q.id === msg.id) ? prev : { messages: [...prev.messages, msg] },
    );
  },
  removeById(id: string): void {
    queueStore.setState((prev) => {
      const next = prev.messages.filter((q) => q.id !== id);
      return next.length === prev.messages.length ? prev : { messages: next };
    });
  },
  removeFirstByText(text: string): void {
    queueStore.setState((prev) => {
      const next = removeFirstQueuedText(prev.messages, text);
      return next.length === prev.messages.length ? prev : { messages: next };
    });
  },
  replace(messages: readonly QueuedMessage[]): void {
    queueStore.setState(() => ({ messages }));
  },
  clear(): void {
    queueStore.setState((prev) => (prev.messages.length === 0 ? prev : { messages: [] }));
  },
};

export function selectQueuedText(): string {
  return queueStore
    .getState()
    .messages.map((m) => m.recallText ?? m.expanded ?? m.text)
    .filter((s) => s.length > 0)
    .join("\n");
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(queueStore.subscribe, queueStore.getState, queueStore.getState);
}

export function useQueueMessages(): readonly QueuedMessage[] {
  return useSyncExternalStore(
    queueStore.subscribe,
    () => queueStore.getState().messages,
    () => queueStore.getState().messages,
  );
}
