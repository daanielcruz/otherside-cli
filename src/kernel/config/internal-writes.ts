/**
 * Remembers the settings files this process just wrote, so a watcher can tell a
 * change the session made from one the reader made.
 *
 * The distinction matters where a change is announced rather than merely applied:
 * a session's own `/config` edit is not news, and announcing it would ask hooks to
 * rule on a change the session already committed to.
 */

/**
 * How long after a write the resulting filesystem event still counts as ours.
 * Generous on purpose — the event is delivered on the platform's schedule, and a
 * settle window sits between the write and the read.
 */
const OWN_WRITE_WINDOW_MS = 5_000;

const writtenAt = new Map<string, number>();

/** Records that this process wrote the file at `path`. */
export function markInternalWrite(path: string): void {
  writtenAt.set(path, Date.now());
}

/**
 * Whether a change to `path` is one this process just made, spending the record
 * so a later change to the same file reads as the reader's.
 */
export function consumeInternalWrite(path: string): boolean {
  const at = writtenAt.get(path);
  if (at === undefined) return false;
  writtenAt.delete(path);
  return Date.now() - at <= OWN_WRITE_WINDOW_MS;
}

export function forgetInternalWrites(): void {
  writtenAt.clear();
}
