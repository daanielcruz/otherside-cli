/**
 * Read a fetch response body to completion, yielding chunks.
 *
 * On a full drain the reader lock is released. On EARLY exit — the consumer
 * breaks (char-cap, oneshot stop), aborts, or throws — the stream is cancelled
 * so the underlying socket and its buffer are freed. Releasing the lock alone
 * leaves the un-consumed body (and its socket) alive, which accumulates in the
 * native allocator across many turns.
 */
export async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let drained = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        drained = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    if (drained) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}
