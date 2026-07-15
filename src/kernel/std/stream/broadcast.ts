export interface BroadcastEntry<T, K extends string> {
  id: string;
  kind: K;
  payload: T;
  ts: number;
}

export interface BroadcastChannel<T, K extends string> {
  publish: (kind: K, payload: T) => BroadcastEntry<T, K>;
  subscribe: (fn: (history: BroadcastEntry<T, K>[]) => void) => () => void;
  snapshot: () => BroadcastEntry<T, K>[];
  clear: () => void;
}

export interface BroadcastOptions {
  prefix: string;
  maxHistory?: number;
}

export function createBroadcastChannel<T, K extends string>(
  options: BroadcastOptions,
): BroadcastChannel<T, K> {
  const { prefix, maxHistory = 100 } = options;
  const queue: BroadcastEntry<T, K>[] = [];
  const listeners = new Set<(history: BroadcastEntry<T, K>[]) => void>();
  let counter = 0;

  function emit(): void {
    const snapshot = [...queue];
    for (const fn of listeners) fn(snapshot);
  }

  return {
    publish(kind, payload) {
      counter++;
      const entry: BroadcastEntry<T, K> = {
        id: `${prefix}_${Date.now()}_${counter}`,
        kind,
        payload,
        ts: Date.now(),
      };
      queue.push(entry);
      while (queue.length > maxHistory) queue.shift();
      emit();
      return entry;
    },
    subscribe(fn) {
      listeners.add(fn);
      fn([...queue]);
      return () => listeners.delete(fn);
    },
    snapshot() {
      return [...queue];
    },
    clear() {
      queue.length = 0;
      emit();
    },
  };
}
