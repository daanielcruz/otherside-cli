export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

export function linkAbort(child: AbortController, parent: AbortSignal | undefined): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort();
    return () => {};
  }
  const onAbort = (): void => child.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}
