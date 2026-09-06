import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";

/**
 * Whether the entry still reads differently on every paint. A running sync tool derives
 * its elapsed readout and its pulsing bullet from the clock, and a sync agent task keeps
 * feeding its row, so neither is finished text: committing it to the document would mean
 * rewriting the document to correct one row on every update — and once the history
 * outgrows the screen, each rewrite physically strands a ghost copy in scrollback.
 * Backgrounded agent rows are NOT in flight: they settle at launch with a frozen
 * projection (their ticking lives in the footer bullets), so they never hold the
 * text after them out of the document.
 */
function isInFlight(entry: SettledEntry): boolean {
  return (
    entry.kind === "tool" && (entry.data.elapsedMs !== undefined || entry.data.taskRunning === true)
  );
}

/** Where the document ends — the first changing entry holds back everything after it. */
function settledBoundary(entries: readonly SettledEntry[]): number {
  const index = entries.findIndex(isInFlight);
  return index === -1 ? entries.length : index;
}

export function settledEntriesOf(entries: readonly SettledEntry[]): readonly SettledEntry[] {
  const boundary = settledBoundary(entries);
  return boundary === entries.length ? entries : entries.slice(0, boundary);
}

export function isSettledAppend(
  current: readonly SettledEntry[],
  next: readonly SettledEntry[],
): boolean {
  if (next.length < current.length) return false;
  for (let index = 0; index < current.length; index++) {
    const previousEntry = current[index];
    const nextEntry = next[index];
    if (previousEntry === nextEntry) continue;
    if (JSON.stringify(previousEntry) !== JSON.stringify(nextEntry)) return false;
  }
  return true;
}
