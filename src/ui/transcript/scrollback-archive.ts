import type { ScrollbackBatch } from "@/terminal-runtime/string-view/component.js";
import { renderSettledEntries } from "@/ui/transcript/entry-lines.ts";
import type { TranscriptPresentation } from "@/ui/transcript/presentation.ts";
import { isSettledAppend } from "@/ui/transcript/settled-boundary.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";

function isRowPrefix(previous: readonly string[], next: readonly string[]): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

/**
 * Settled-history archive for a conversation surface: tracks which entries have
 * already been committed to native scrollback and turns each paint into the
 * cheapest batch that keeps the buffer true — idle when nothing changed, add for
 * pure appends, reflow only when settled history was rewritten. A restamp that
 * does not change a rendered row downgrades to idle/add, because a reflow erases
 * and repaints the whole buffer.
 */
export class SettledScrollbackArchive {
  private settled: readonly SettledEntry[] = [];
  private archivedEntries: readonly SettledEntry[] = [];
  private archivedRows: readonly string[] | undefined;
  private archiveColumns: number | undefined;
  private needsReflow = true;

  /** The current settled prefix, as last handed to {@link setSettled}. */
  settledEntries(): readonly SettledEntry[] {
    return this.settled;
  }

  setSettled(settled: readonly SettledEntry[]): void {
    if (!isSettledAppend(this.settled, settled)) this.needsReflow = true;
    this.settled = settled;
  }

  /** Forces the next batch to regenerate the surface (presentation change, document swap). */
  invalidate(): void {
    this.needsReflow = true;
  }

  reset(): void {
    this.settled = [];
    this.archivedEntries = [];
    this.archivedRows = undefined;
    this.archiveColumns = undefined;
    this.needsReflow = true;
  }

  takeBatch(width: number, presentation: TranscriptPresentation): ScrollbackBatch {
    const columns = Math.max(1, width);
    if (this.needsReflow || this.archiveColumns !== columns) {
      const previousRows = this.archiveColumns === columns ? this.archivedRows : undefined;
      const rows = this.snapshot(columns, presentation);
      if (previousRows !== undefined && isRowPrefix(previousRows, rows)) {
        return rows.length === previousRows.length
          ? { mode: "idle" }
          : { mode: "add", rows: rows.slice(previousRows.length) };
      }
      return { mode: "reflow", rows };
    }
    if (this.archivedEntries.length === this.settled.length) return { mode: "idle" };

    const newlyArchived = this.settled.slice(this.archivedEntries.length);
    this.archivedEntries = this.settled;
    const rows = renderSettledEntries(columns, newlyArchived, presentation);
    this.archivedRows = this.archivedRows ? [...this.archivedRows, ...rows] : undefined;
    return { mode: "add", rows };
  }

  snapshot(width: number, presentation: TranscriptPresentation): readonly string[] {
    const columns = Math.max(1, width);
    const rows = renderSettledEntries(columns, this.settled, presentation);
    this.archivedEntries = this.settled;
    this.archivedRows = rows;
    this.archiveColumns = columns;
    this.needsReflow = false;
    return rows;
  }
}
