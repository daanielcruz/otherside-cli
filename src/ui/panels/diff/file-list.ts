/**
 * The changed files as something the reader can walk.
 *
 * A summary that only counts them makes the reader read the whole patch to find
 * the one file they care about; naming a row and jumping to it is the difference
 * between a list and a table of contents.
 */

/** The path inside a `git status --short` row, or null when there is none. */
export function statusPath(line: string): string | null {
  // Two status columns, a space, then the path — and a rename carries both.
  const path = line.slice(3).trim();
  if (path.length === 0) return null;
  const renamed = path.split(" -> ");
  return (renamed[renamed.length - 1] ?? path).trim() || null;
}

/**
 * Where a file's hunk starts in the patch, or null when the patch does not
 * carry it — a staged-only or untracked file is listed but has nothing to show.
 */
export function patchLineForPath(patch: readonly string[], path: string): number | null {
  const needle = `b/${path}`;
  for (const [index, line] of patch.entries()) {
    if (line.startsWith("diff --git ") && line.endsWith(needle)) return index;
  }
  return null;
}

/** The cursor after a step, kept inside the list and never wrapping. */
export function steppedCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, cursor + delta));
}
