export class AsyncStream<T> {
  private buffer: T[] = [];
  private waiter: { resolve: () => void } | null = null;

  push(event: T): void {
    this.buffer.push(event);
    const w = this.waiter;
    this.waiter = null;
    w?.resolve();
  }

  signal(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.resolve();
  }

  async *iterate(isDone: () => boolean): AsyncGenerator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const next = this.buffer.shift();
        if (next !== undefined) yield next;
      }
      if (isDone()) return;
      await new Promise<void>((resolve) => {
        this.waiter = { resolve };
      });
    }
  }
}
