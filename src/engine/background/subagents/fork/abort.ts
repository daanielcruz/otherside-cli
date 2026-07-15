import { AbortError } from "@/kernel/std/stream/abort.ts";

export function combineAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal,
): AbortSignal {
  if (primary === undefined) return secondary;
  return AbortSignal.any([primary, secondary]);
}

export async function* iterateWithAbortSignal<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let active = true;
  try {
    while (true) {
      if (signal.aborted) throw new AbortError();
      const next = await raceAbort(iterator.next(), signal);
      if (next.done === true) {
        active = false;
        return;
      }
      yield next.value;
    }
  } finally {
    if (active) void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = (): void => reject(new AbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
