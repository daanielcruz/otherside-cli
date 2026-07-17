// Reverse-incremental prompt history search (Ctrl+R): scans entries newest to
// oldest for the query, skipping duplicate displays; repeating the search
// continues from the last match toward older entries.

export interface HistoryMatch {
  // Index into the newest-first scan order; the continuation cursor.
  scanIndex: number;
  value: string;
  // Offset of the query in the value (its last occurrence).
  matchOffset: number;
}

export function findHistoryMatch(
  entries: readonly string[],
  query: string,
  fromScanIndex: number,
): HistoryMatch | null {
  if (query.length === 0) return null;
  const seen = new Set<string>();
  for (let scanIndex = 0; scanIndex < entries.length; scanIndex++) {
    const value = entries[entries.length - 1 - scanIndex];
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    if (scanIndex < fromScanIndex) continue;
    const matchOffset = value.lastIndexOf(query);
    if (matchOffset !== -1) return { scanIndex, value, matchOffset };
  }
  return null;
}
