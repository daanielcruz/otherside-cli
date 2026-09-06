import type { TaskRecord, TaskStatus } from "@/engine/background/tasks/index.ts";

import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { Color, type ColorValue, Glyph } from "@/ui/theme/theme.ts";

const DISPLAY_ROWS_FLOOR = 10;
const DISPLAY_CAP = 10;
const MIN_DISPLAY = 3;
const DISPLAY_ROW_RESERVE = 14;
/**
 * How long a task that just finished keeps its place in the list. Without the
 * window a completion vanishes the instant it lands, so the user never sees the
 * row strike through.
 */
export const RECENT_COMPLETED_TTL_MS = 30_000;
const SUBJECT_WIDTH_RESERVE = 15;
const MIN_SUBJECT_WIDTH = 15;
/** The owner badge costs columns a narrow terminal cannot spare. */
const OWNER_BADGE_MIN_COLUMNS = 60;

export interface HiddenTaskCounts {
  readonly inProgress: number;
  readonly pending: number;
  readonly completed: number;
}

/** How many task rows the viewport can spend; zero means the list does not fit. */
export function computeMaxTaskRows(terminalRows: number): number {
  if (terminalRows <= DISPLAY_ROWS_FLOOR) return 0;
  return Math.min(DISPLAY_CAP, Math.max(MIN_DISPLAY, terminalRows - DISPLAY_ROW_RESERVE));
}

function compareIds(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return a.localeCompare(b);
}

function byIdAsc(a: TaskRecord, b: TaskRecord): number {
  return compareIds(a.id, b.id);
}

export function isInternalTask(task: TaskRecord): boolean {
  return task.metadata._internal === true;
}

function unresolvedIdsOf(tasks: readonly TaskRecord[]): Set<string> {
  return new Set(tasks.filter((task) => task.status !== "completed").map((task) => task.id));
}

/**
 * Choose which rows to show. Priority applies ONLY under truncation pressure: when
 * every task fits, rows keep stable ascending-id order whatever their status, so a
 * list the user is reading does not reshuffle as work progresses.
 */
export function selectVisibleTasks(options: {
  tasks: readonly TaskRecord[];
  maxDisplay: number;
  recentCompletedIds: ReadonlySet<string>;
}): { visible: TaskRecord[]; hidden: HiddenTaskCounts } {
  const { tasks, maxDisplay, recentCompletedIds } = options;
  if (tasks.length <= maxDisplay) {
    return {
      visible: [...tasks].sort(byIdAsc),
      hidden: { inProgress: 0, pending: 0, completed: 0 },
    };
  }

  const recentCompleted: TaskRecord[] = [];
  const olderCompleted: TaskRecord[] = [];
  for (const task of tasks.filter((task) => task.status === "completed")) {
    if (recentCompletedIds.has(task.id)) recentCompleted.push(task);
    else olderCompleted.push(task);
  }
  recentCompleted.sort(byIdAsc);
  olderCompleted.sort(byIdAsc);

  const inProgress = tasks.filter((task) => task.status === "in_progress").sort(byIdAsc);
  const unresolved = unresolvedIdsOf(tasks);
  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((a, b) => {
      const aBlocked = a.blockedBy.some((id) => unresolved.has(id));
      const bBlocked = b.blockedBy.some((id) => unresolved.has(id));
      if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
      return byIdAsc(a, b);
    });

  const prioritized = [...recentCompleted, ...inProgress, ...pending, ...olderCompleted];
  const hiddenTasks = prioritized.slice(maxDisplay);
  return {
    visible: prioritized.slice(0, maxDisplay),
    hidden: {
      inProgress: hiddenTasks.filter((task) => task.status === "in_progress").length,
      pending: hiddenTasks.filter((task) => task.status === "pending").length,
      completed: hiddenTasks.filter((task) => task.status === "completed").length,
    },
  };
}

/** The task the user would pick up next: first unblocked pending, else first pending. */
export function findNextPendingTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
  const pending = tasks.filter((task) => task.status === "pending");
  if (pending.length === 0) return undefined;
  const unresolved = unresolvedIdsOf(tasks);
  return pending.find((task) => !task.blockedBy.some((id) => unresolved.has(id))) ?? pending[0];
}

/** The task whose activeForm the spinner speaks: the one being worked on now. */
export function findCurrentTask(tasks: readonly TaskRecord[]): TaskRecord | undefined {
  return tasks.find((task) => task.status !== "pending" && task.status !== "completed");
}

export function openBlockerIds(task: TaskRecord, unresolved: ReadonlySet<string>): string[] {
  return task.blockedBy.filter((id) => unresolved.has(id)).sort(compareIds);
}

/**
 * Who holds the task — shown only while that owner has a live agent, so a claim
 * left behind by a finished run stays silent.
 */
export function ownerBadge(options: {
  task: TaskRecord;
  activeOwners: ReadonlySet<string>;
  columns: number;
}): string | null {
  const { task, activeOwners, columns } = options;
  if (columns < OWNER_BADGE_MIN_COLUMNS) return null;
  if (task.owner === undefined || task.owner.length === 0) return null;
  if (!activeOwners.has(task.owner)) return null;
  return ` (@${task.owner})`;
}

/**
 * What the list holds, counted by status. Only the standalone list carries it: during a
 * turn the spinner above already names the work, but on its own the list hangs off
 * nothing and has to say what it is. The in-progress term is dropped when none is.
 */
export function taskCountsHeader(tasks: readonly TaskRecord[]): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const inProgress = tasks.length - completed - pending;
  const total = (value: number): string =>
    renderTextWithStyles(String(value), { color: Color.muted, bold: true });
  const label = (text: string): string => renderTextWithStyles(text, { color: Color.muted });
  return (
    total(tasks.length) +
    label(" tasks (") +
    total(completed) +
    label(" done, ") +
    (inProgress > 0 ? total(inProgress) + label(" in progress, ") : "") +
    total(pending) +
    label(" open)")
  );
}

/** What was left out, counted by status; empty when everything is on screen. */
export function hiddenTaskSummary(hidden: HiddenTaskCounts): string {
  const parts: string[] = [];
  if (hidden.inProgress > 0) parts.push(`${hidden.inProgress} in progress`);
  if (hidden.pending > 0) parts.push(`${hidden.pending} pending`);
  if (hidden.completed > 0) parts.push(`${hidden.completed} completed`);
  return parts.length === 0 ? "" : `… +${parts.join(", ")}`;
}

function limitColumnWidth(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  let kept = "";
  let used = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (used + charWidth > Math.max(1, max - 1)) break;
    kept += char;
    used += charWidth;
  }
  return `${kept}…`;
}

export function taskStatusGlyph(status: TaskStatus): string {
  if (status === "completed") return Glyph.check;
  if (status === "in_progress") return Glyph.squareSmallFilled;
  return Glyph.squareSmall;
}

export function taskStatusColor(status: TaskStatus): ColorValue {
  if (status === "completed") return Color.success;
  if (status === "in_progress") return Color.primary;
  return Color.text;
}

/** One task's line, without the gutter the caller wraps it in. */
export function taskRowText(options: {
  task: TaskRecord;
  openBlockers: readonly string[];
  activeOwners: ReadonlySet<string>;
  columns: number;
}): string {
  const { task, openBlockers, activeOwners, columns } = options;
  const blocked = openBlockers.length > 0;
  const badge = ownerBadge({ task, activeOwners, columns });
  const badgeWidth = badge === null ? 0 : stringWidth(badge);
  const subjectWidth = Math.max(MIN_SUBJECT_WIDTH, columns - SUBJECT_WIDTH_RESERVE - badgeWidth);

  const glyph = renderTextWithStyles(`${taskStatusGlyph(task.status)} `, {
    color: taskStatusColor(task.status),
  });
  const subject = renderTextWithStyles(limitColumnWidth(task.subject, subjectWidth), {
    color: task.status === "completed" || blocked ? Color.muted : Color.text,
    bold: task.status === "in_progress",
    strikethrough: task.status === "completed",
  });
  const owner = badge === null ? "" : renderTextWithStyles(badge, { color: Color.muted });
  const blockedLabel = blocked
    ? renderTextWithStyles(
        ` ${Glyph.chevronThin}blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}`,
        { color: Color.muted },
      )
    : "";
  return `${glyph}${subject}${owner}${blockedLabel}`;
}

/**
 * Tracks when each task finished, so a completion can hold its place briefly.
 * Recency is observed, not inferred: tasks already complete when tracking starts
 * are never "recent", or a resumed session would open with a burst of them.
 *
 * Recency is also per board. The same tracker watches whichever planning list is
 * on screen — the session's own, or an open agent's — and boards number their
 * tasks independently, so a bare id means nothing across lists. Comparing one
 * board's completed set against another's would stamp every completion of a
 * returning board as fresh, parading long-finished rows as if they just landed.
 * A board switch therefore restarts tracking from the incoming board's state.
 */
export class RecentCompletions {
  private readonly finishedAt = new Map<string, number>();
  private known: Set<string> | null = null;
  private boardId: string | null = null;

  observe(tasks: readonly TaskRecord[], now: number, boardId = ""): void {
    const completed = new Set(
      tasks.filter((task) => task.status === "completed").map((task) => task.id),
    );
    if (this.known === null || boardId !== this.boardId) {
      this.boardId = boardId;
      this.finishedAt.clear();
      this.known = completed;
      return;
    }
    for (const id of completed) {
      if (!this.known.has(id)) this.finishedAt.set(id, now);
    }
    for (const id of [...this.finishedAt.keys()]) {
      if (!completed.has(id)) this.finishedAt.delete(id);
    }
    this.known = completed;
  }

  recentIds(now: number): ReadonlySet<string> {
    const recent = new Set<string>();
    for (const [id, at] of this.finishedAt) {
      if (now - at < RECENT_COMPLETED_TTL_MS) recent.add(id);
    }
    return recent;
  }

  /**
   * Milliseconds until the soonest recency expiry, or undefined with none
   * pending. A row leaving the window changes the list without any store
   * event, so the widget arms a repaint for exactly this moment.
   */
  nextExpiryDelay(now: number): number | undefined {
    let soonest: number | undefined;
    for (const at of this.finishedAt.values()) {
      const remaining = at + RECENT_COMPLETED_TTL_MS - now;
      if (remaining <= 0) continue;
      if (soonest === undefined || remaining < soonest) soonest = remaining;
    }
    return soonest;
  }
}
