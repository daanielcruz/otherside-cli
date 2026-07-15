type QueueMessageLookup = (id: string) => unknown;

export interface QueuedMessagesProvider {
  setQueuedMessageLookup(lookup: QueueMessageLookup): void;
  subscribeQueueDrain(
    fn: (result: { removedQueuedMessageIds: readonly string[] }) => void,
  ): () => void;
}

let provider: QueuedMessagesProvider | null = null;

export function registerQueuedMessagesProvider(impl: QueuedMessagesProvider): void {
  provider = impl;
}

function requireQueuedMessagesProvider(): QueuedMessagesProvider {
  if (provider === null) {
    throw new Error("Queued message provider is not registered");
  }
  return provider;
}

export function setQueuedMessageLookup(lookup: QueueMessageLookup): void {
  requireQueuedMessagesProvider().setQueuedMessageLookup(lookup);
}

export function subscribeQueueDrain(
  fn: (result: { removedQueuedMessageIds: readonly string[] }) => void,
): () => void {
  return requireQueuedMessagesProvider().subscribeQueueDrain(fn);
}

export function _resetQueuedMessagesProviderForTests(): void {
  provider = null;
}
