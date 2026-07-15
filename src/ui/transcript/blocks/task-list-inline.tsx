import { memo, useEffect, useRef, useState } from "react";
import type { TaskRecord, TaskStatus } from "@/engine/background/tasks/index.ts";
import { list as listTasks, subscribe as subscribeTasks } from "@/engine/background/tasks/index.ts";
import type { Color as InkColor } from "@/ink";
import { Box, Text, useTerminalDimensions } from "@/ink";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";

const MAX_DISPLAY_ROWS_FLOOR = 10;
const MAX_DISPLAY_CAP = 5;
const MIN_DISPLAY = 3;
const DISPLAY_ROW_RESERVE = 14;
// Rows that finished within this window keep display priority so the user
// sees them strike through before they sink below the active rows.
const RECENT_COMPLETED_TTL_MS = 30_000;
const SUBJECT_WIDTH_RESERVE = 15;
const MIN_SUBJECT_WIDTH = 15;

function computeMaxDisplay(rows: number): number {
  if (rows <= MAX_DISPLAY_ROWS_FLOOR) return 0;
  return Math.min(MAX_DISPLAY_CAP, Math.max(MIN_DISPLAY, rows - DISPLAY_ROW_RESERVE));
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
  return Boolean(task.metadata._internal);
}

// Priority reordering applies ONLY under truncation pressure; when everything
// fits, rows stay in stable ascending-ID order regardless of status.
export function selectVisibleTasks(options: {
  tasks: TaskRecord[];
  maxDisplay: number;
  recentCompletedIds: ReadonlySet<string>;
}): {
  visible: TaskRecord[];
  hidden: { inProgress: number; pending: number; completed: number };
} {
  const { tasks, maxDisplay, recentCompletedIds } = options;
  let visible: TaskRecord[];
  let hiddenTasks: TaskRecord[];
  if (tasks.length > maxDisplay) {
    const recentCompleted: TaskRecord[] = [];
    const olderCompleted: TaskRecord[] = [];
    for (const task of tasks.filter((t) => t.status === "completed")) {
      if (recentCompletedIds.has(task.id)) recentCompleted.push(task);
      else olderCompleted.push(task);
    }
    recentCompleted.sort(byIdAsc);
    olderCompleted.sort(byIdAsc);
    const inProgress = tasks.filter((t) => t.status === "in_progress").sort(byIdAsc);
    const unresolved = new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));
    const pending = tasks
      .filter((t) => t.status === "pending")
      .sort((a, b) => {
        const aBlocked = a.blockedBy.some((id) => unresolved.has(id));
        const bBlocked = b.blockedBy.some((id) => unresolved.has(id));
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        return byIdAsc(a, b);
      });
    const prioritized = [...recentCompleted, ...inProgress, ...pending, ...olderCompleted];
    visible = prioritized.slice(0, maxDisplay);
    hiddenTasks = prioritized.slice(maxDisplay);
  } else {
    visible = [...tasks].sort(byIdAsc);
    hiddenTasks = [];
  }
  return {
    visible,
    hidden: {
      inProgress: hiddenTasks.filter((t) => t.status === "in_progress").length,
      pending: hiddenTasks.filter((t) => t.status === "pending").length,
      completed: hiddenTasks.filter((t) => t.status === "completed").length,
    },
  };
}

export function findNextPendingTask(tasks: TaskRecord[]): TaskRecord | undefined {
  const pending = tasks.filter((t) => t.status === "pending");
  if (pending.length === 0) return undefined;
  const unresolved = new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));
  return pending.find((t) => !t.blockedBy.some((id) => unresolved.has(id))) ?? pending[0];
}

function statusGlyph(status: TaskStatus): string {
  if (status === "completed") return Glyph.check;
  if (status === "in_progress") return Glyph.squareSmallFilled;
  return Glyph.squareSmall;
}

function statusGlyphColor(status: TaskStatus): InkColor | undefined {
  if (status === "completed") return Color.success;
  if (status === "in_progress") return Color.primary;
  return undefined;
}

export function openBlockerIds(task: TaskRecord, unresolvedIds: ReadonlySet<string>): string[] {
  return task.blockedBy.filter((id) => unresolvedIds.has(id)).sort(compareIds);
}

function truncateToWidth(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  let acc = "";
  let used = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (used + charWidth > Math.max(1, max - 1)) break;
    acc += char;
    used += charWidth;
  }
  return `${acc}…`;
}

function TaskRow({
  task,
  connector,
  openBlockers,
  columns,
}: {
  task: TaskRecord;
  connector?: string;
  openBlockers: string[];
  columns: number;
}): React.JSX.Element {
  const isCompleted = task.status === "completed";
  const isBlocked = openBlockers.length > 0;
  const glyphColor = statusGlyphColor(task.status);
  const maxSubjectWidth = Math.max(MIN_SUBJECT_WIDTH, columns - SUBJECT_WIDTH_RESERVE);
  const subject = truncateToWidth(task.subject, maxSubjectWidth);
  return (
    <Box>
      {!!connector && <Text color={Color.muted}>{connector}</Text>}
      <Text {...(glyphColor !== undefined ? { color: glyphColor } : { color: Color.text })}>
        {statusGlyph(task.status)}{" "}
      </Text>
      <Text
        color={isCompleted || isBlocked ? Color.muted : Color.text}
        strikethrough={isCompleted}
        {...(task.status === "in_progress" ? { bold: true } : {})}
      >
        {subject}
      </Text>
      {isBlocked && (
        <Text color={Color.muted}>
          {" "}
          {Glyph.chevronThin}blocked by {openBlockers.map((id) => `#${id}`).join(", ")}
        </Text>
      )}
    </Box>
  );
}

// Completion recency is view-local and transition-based: tasks already
// completed when the widget mounts are never "recent"; only completions the
// widget observes get the 30s priority window.
function useRecentCompletedIds(tasks: TaskRecord[]): ReadonlySet<string> {
  const completionTimestampsRef = useRef(new Map<string, number>());
  const previousCompletedIdsRef = useRef<Set<string> | null>(null);
  const [, forceUpdate] = useState(0);
  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(
      tasks.filter((t) => t.status === "completed").map((t) => t.id),
    );
  }
  const currentCompletedIds = new Set(
    tasks.filter((t) => t.status === "completed").map((t) => t.id),
  );
  const now = Date.now();
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) {
      completionTimestampsRef.current.set(id, now);
    }
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) {
      completionTimestampsRef.current.delete(id);
    }
  }
  previousCompletedIdsRef.current = currentCompletedIds;

  // Re-render when the next recent completion leaves its priority window.
  useEffect(() => {
    if (completionTimestampsRef.current.size === 0) return;
    const currentNow = Date.now();
    let earliestExpiry = Infinity;
    for (const ts of completionTimestampsRef.current.values()) {
      const expiry = ts + RECENT_COMPLETED_TTL_MS;
      if (expiry > currentNow && expiry < earliestExpiry) earliestExpiry = expiry;
    }
    if (earliestExpiry === Infinity) return;
    const timer = setTimeout(() => forceUpdate((n) => n + 1), earliestExpiry - currentNow);
    return () => clearTimeout(timer);
  }, [tasks]);

  const recent = new Set<string>();
  for (const [id, ts] of completionTimestampsRef.current) {
    if (now - ts < RECENT_COMPLETED_TTL_MS) recent.add(id);
  }
  return recent;
}

function TaskListInlineImpl({ standalone }: { standalone: boolean }): React.JSX.Element | null {
  const [allTasks, setAllTasks] = useState<TaskRecord[]>(() => listTasks());
  const { rows, columns } = useTerminalDimensions();

  useEffect(() => {
    return subscribeTasks(() => {
      setAllTasks(listTasks());
    });
  }, []);

  const tasks = allTasks.filter((t) => !isInternalTask(t));
  const recentCompletedIds = useRecentCompletedIds(tasks);

  if (tasks.length === 0) return null;

  const maxDisplay = computeMaxDisplay(rows);
  const { visible, hidden } = selectVisibleTasks({ tasks, maxDisplay, recentCompletedIds });
  const unresolvedIds = new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));

  const parts: string[] = [];
  if (hidden.inProgress > 0) parts.push(`${hidden.inProgress} in progress`);
  if (hidden.pending > 0) parts.push(`${hidden.pending} pending`);
  if (hidden.completed > 0) parts.push(`${hidden.completed} completed`);
  const hiddenSummary = parts.length > 0 ? ` … +${parts.join(", ")}` : "";
  const showOverflow = maxDisplay > 0 && hiddenSummary.length > 0;

  if (!standalone) {
    return (
      <Box flexDirection="column">
        {visible.map((t, idx) => (
          <TaskRow
            key={t.id}
            task={t}
            connector={idx === 0 ? GUTTER_HEAD : GUTTER_CONT}
            openBlockers={openBlockerIds(t, unresolvedIds)}
            columns={columns}
          />
        ))}
        {showOverflow && <Text color={Color.muted}>{`${GUTTER_CONT}${hiddenSummary.trim()}`}</Text>}
      </Box>
    );
  }

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const inProgressCount = tasks.length - completedCount - pendingCount;

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={Color.muted}>
          <Text bold>{tasks.length}</Text>
          {" tasks ("}
          <Text bold>{completedCount}</Text>
          {" done, "}
          {inProgressCount > 0 && (
            <Text color={Color.muted}>
              <Text bold>{inProgressCount}</Text>
              {" in progress, "}
            </Text>
          )}
          <Text bold>{pendingCount}</Text>
          {" open)"}
        </Text>
      </Box>
      {visible.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          openBlockers={openBlockerIds(t, unresolvedIds)}
          columns={columns}
        />
      ))}
      {showOverflow && <Text color={Color.muted}>{hiddenSummary}</Text>}
    </Box>
  );
}

function TaskListInlineWrapper(props: { standalone?: boolean }): React.JSX.Element | null {
  return <TaskListInlineImpl standalone={props.standalone ?? false} />;
}

export const TaskListInline = memo(TaskListInlineWrapper);
