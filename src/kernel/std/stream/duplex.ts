export interface ResolveOnce<T> {
  resolve: (value: T) => void;
  isResolved: () => boolean;
  claim: () => boolean;
}

export function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let resolved = false;
  return {
    resolve(value) {
      if (resolved) return;
      resolved = true;
      resolve(value);
    },
    isResolved() {
      return resolved;
    },
    claim() {
      if (resolved) return false;
      resolved = true;
      return true;
    },
  };
}

export interface DuplexChannel<TReq extends { id: string; resolve: (value: TRes) => void }, TRes> {
  ask: (build: (id: string, resolve: (value: TRes) => void) => TReq) => Promise<TRes>;
  answer: (id: string, value: TRes) => boolean;
  peek: () => TReq | null;
  list: () => TReq[];
  subscribe: (listener: (queue: TReq[]) => void) => () => void;
  clear: (cancelValue: (entry: TReq) => TRes) => void;
}

interface Entry<TReq, TRes> {
  id: string;
  request: TReq;
  resolve: (value: TRes) => void;
}

export function createDuplexChannel<
  TReq extends { id: string; resolve: (value: TRes) => void },
  TRes,
>(prefix: string): DuplexChannel<TReq, TRes> {
  const queue: Entry<TReq, TRes>[] = [];
  const listeners = new Set<(snapshot: TReq[]) => void>();
  let counter = 0;

  function emit(): void {
    const snapshot = queue.map((e) => e.request);
    for (const fn of listeners) fn(snapshot);
  }

  return {
    ask(build) {
      return new Promise<TRes>((resolve) => {
        const resolveOnce = createResolveOnce(resolve);
        counter++;
        const id = `${prefix}_${Date.now()}_${counter}`;
        const request = build(id, resolveOnce.resolve);
        // An abort can occur while the request is being built. Do not publish a
        // request whose resolver has already claimed the cancellation result.
        if (resolveOnce.isResolved()) return;
        queue.push({ id, request, resolve: request.resolve });
        emit();
      });
    },
    answer(id, value) {
      const idx = queue.findIndex((e) => e.id === id);
      if (idx < 0) return false;
      const [entry] = queue.splice(idx, 1);
      if (!entry) return false;
      entry.resolve(value);
      emit();
      return true;
    },
    peek() {
      return queue[0]?.request ?? null;
    },
    list() {
      return queue.map((e) => e.request);
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(queue.map((e) => e.request));
      return () => listeners.delete(fn);
    },
    clear(cancelValue) {
      for (const entry of queue) entry.resolve(cancelValue(entry.request));
      queue.length = 0;
      emit();
    },
  };
}
