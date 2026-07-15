export interface MacrotaskBatch {
  enqueue: (apply: () => void) => void;
  flushNow: () => void;
}

export function makeMacrotaskBatch(): MacrotaskBatch {
  let queue: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    while (queue.length > 0) {
      const ready = queue;
      queue = [];
      for (const apply of ready) apply();
    }
  };
  const enqueue = (apply: () => void): void => {
    queue.push(apply);
    if (timer !== null) return;
    timer = setTimeout(flushNow, 0);
  };
  return { enqueue, flushNow };
}
