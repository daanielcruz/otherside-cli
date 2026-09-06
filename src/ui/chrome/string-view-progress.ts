import { listRunning as listRunningAgents } from "@/engine/background/tasks/background.ts";
import {
  subscribe as subscribeTasks,
  type TaskRecord,
  taskListIdForScope,
} from "@/engine/background/tasks/index.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import { appStore } from "@/store/app-store/index.ts";
import type { RetryStatusLine } from "@/store/app-store/slices/view.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import {
  type ViewedThread,
  viewedAgentId,
  viewedThread,
  viewedThreadBusy,
} from "@/ui/app/viewed-thread.ts";
import { AllCompleteBoardReset } from "@/ui/chrome/progress/all-complete-reset.ts";
import { anyFrameClientAnimating } from "@/ui/chrome/progress/frame-clients.ts";
import {
  compactProgressBarParts,
  compactProgressRatio,
  formatElapsed,
  monotonicRatio,
  reasoningGlowColor,
  shimmerSegments,
  spinnerFrame,
  tipAt,
} from "@/ui/chrome/progress/index.ts";
import {
  computeMaxTaskRows,
  findCurrentTask,
  findNextPendingTask,
  hiddenTaskSummary,
  isInternalTask,
  openBlockerIds,
  RecentCompletions,
  selectVisibleTasks,
  taskCountsHeader,
  taskRowText,
} from "@/ui/chrome/progress/task-list.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph, GUTTER_CONT, GUTTER_HEAD } from "@/ui/theme/theme.ts";
import { wrapOutputRows } from "@/ui/transcript/presentation.ts";
import { RATE_LIMIT_PATTERN } from "@/ui/transcript/stream/retry.ts";

const FRAME_MS = 120;
/** Announced beside the next task, and only while the list it opens is closed. */
const TASK_LIST_HINT = "  (ctrl+t to show tasks)";
const COMPACTING_VERB = "Compacting conversation";

export class StringViewProgress implements StringComponent {
  private timer: ReturnType<typeof setInterval> | undefined;
  private recencyTimer: ReturnType<typeof setTimeout> | undefined;
  private requestRender: (() => void) | undefined;
  private taskUnsub: (() => void) | undefined;
  private viewUnsub: (() => void) | undefined;
  private expanded = false;
  private viewedAgent: string | null = null;
  private tasks: TaskRecord[] = [];
  private displayedCompactRatio = 0;
  private compactStartedAt: number | null = null;
  private displayedTokens = 0;
  private readonly recentCompletions = new RecentCompletions();
  private allCompleteReset: AllCompleteBoardReset | undefined;

  mount(ctx: StringViewContext): void {
    this.unmount();
    // A board every task of which is done retires shortly after: this component
    // is the always-mounted reader of the session's list, so it hosts the watcher
    // that keeps a finished plan's rows from lingering into the next one.
    const allCompleteReset = new AllCompleteBoardReset();
    this.allCompleteReset = allCompleteReset;
    this.taskUnsub = subscribeTasks(() => {
      allCompleteReset.check();
      ctx.requestRender();
    });
    allCompleteReset.check();
    // Outside a turn the list is the only thing this slot draws. The toggle and the
    // document in view are the only store fields that change it — repainting on
    // anything else would charge the whole footer for state this component ignores.
    this.expanded = appStore.getState().view.tasksExpanded;
    this.viewedAgent = viewedAgentId();
    this.viewUnsub = appStore.subscribe(() => {
      const expanded = appStore.getState().view.tasksExpanded;
      const agent = viewedAgentId();
      if (expanded === this.expanded && agent === this.viewedAgent) return;
      this.expanded = expanded;
      this.viewedAgent = agent;
      ctx.requestRender();
    });
    this.requestRender = ctx.requestRender;
    // The frame clock answers for whichever thread the document in view belongs
    // to: an open agent's live turn animates the spinner exactly like the
    // leader's own, main generator idle or not. Registered frame clients (a busy
    // panel's spinner) ride the same clock.
    this.timer = setInterval(() => {
      if (viewedThreadBusy() || anyFrameClientAnimating()) ctx.requestRender();
    }, FRAME_MS);
  }

  unmount(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.recencyTimer) clearTimeout(this.recencyTimer);
    this.recencyTimer = undefined;
    this.requestRender = undefined;
    this.taskUnsub?.();
    this.taskUnsub = undefined;
    this.viewUnsub?.();
    this.viewUnsub = undefined;
    this.allCompleteReset?.dispose();
    this.allCompleteReset = undefined;
  }

  render(width: number): string[] {
    const now = Date.now();
    const thread = viewedThread();
    this.tasks = this.scopedTasks(thread);
    this.recentCompletions.observe(this.tasks, now, boardKeyFor(thread));
    this.armRecencyRepaint(now);
    if (!thread.busy) {
      this.displayedCompactRatio = 0;
      this.compactStartedAt = null;
      this.displayedTokens = 0;
      return this.idleTaskRows(width, now);
    }
    const view = appStore.getState().view;
    // A retry belongs to the leader's request; an open agent reports its own work.
    if (view.retryStatus && thread.agent === null) {
      return retryProgressRows(view.retryStatus, width, now);
    }
    // The task being worked on speaks for the turn: its activeForm is written to be
    // read here, and its subject stands in when it has none. Compaction is the
    // exception — it owns the whole turn, so its verb (and the bar under it)
    // outranks whatever task the board still marks in progress.
    const current = findCurrentTask(this.tasks);
    const compacting = thread.agent === null && view.turnVerb === COMPACTING_VERB;
    const verb = compacting
      ? COMPACTING_VERB
      : (thread.verb ?? (current?.activeForm || current?.subject || view.turnVerb || "Thinking"));
    const startedAt = thread.startedAt ?? now;
    const { before, shimmer, after } = shimmerSegments(verb, now);
    this.displayedTokens = syncCounter(this.displayedTokens, thread.outputTokens);
    const tokenPart =
      this.displayedTokens > 0 && !compacting
        ? ` · ${view.spinnerMode === "requesting" ? Glyph.arrowUp : Glyph.arrowDown} ${formatTokenCount(this.displayedTokens)} tokens`
        : "";
    const reasoningLive = !compacting && view.thinkingStatus === "thinking";
    let thinkingPart = compacting
      ? ""
      : formatThinkingStatus(view.thinkingStatus, thread.broker.effort);
    const elapsedPart = formatElapsed(now - startedAt);
    // When the suffixed label overflows the row, the bare label still earns
    // its slot before the readout drops it entirely.
    const plainLine = (part: string) =>
      `${spinnerFrame(now)} ${verb}… (${elapsedPart}${tokenPart}${part ? ` · ${part}` : ""})`;
    if (reasoningLive && stringWidth(plainLine(thinkingPart)) > width) {
      thinkingPart = "reasoning";
    }
    const statusHead = `(${elapsedPart}${tokenPart}${thinkingPart ? " · " : ""}`;
    const statusRendered = reasoningLive
      ? renderTextWithStyles(statusHead, { color: Color.muted }) +
        renderTextWithStyles(thinkingPart, { color: reasoningGlowColor(now - startedAt) }) +
        renderTextWithStyles(")", { color: Color.muted })
      : renderTextWithStyles(`${statusHead}${thinkingPart})`, { color: Color.muted });
    const line =
      `${renderTextWithStyles(spinnerFrame(now), { color: Color.primary, bold: true })} ` +
      renderTextWithStyles(before, { color: Color.primary }) +
      renderTextWithStyles(shimmer, { color: Color.primaryGlow, bold: true }) +
      renderTextWithStyles(after, { color: Color.primary }) +
      renderTextWithStyles("… ", { color: Color.primary }) +
      statusRendered;
    // The toggle decides whether the list is open; unopened, the slot carries a
    // single row naming what comes next. Compaction keeps the list because its rows
    // are what the compaction is preserving.
    const showTasks = this.tasks.length > 0 && (view.tasksExpanded || compacting);
    const detailRows = showTasks
      ? this.taskListRows(width, now, true)
      : this.collapsedDetailRows(width, view.turnTipIndex ?? 0);
    const rows = compacting ? ["", line] : [line];
    if (compacting) {
      rows.push(this.compactBarRow(startedAt, now));
    } else {
      this.displayedCompactRatio = 0;
      this.compactStartedAt = null;
    }
    // A blank tail keeps the thinking/tip block off the promptbar below it.
    rows.push(...detailRows, "");
    return rows;
  }

  /**
   * With the list collapsed the next task the user could pick up is worth more than
   * a tip, so it takes the row whenever one exists. The shortcut that opens the list
   * rides along with it: the row naming the next task is where a reader is already
   * looking for the rest of them, and it only appears while the list is closed.
   */
  private collapsedDetailRows(width: number, tipIndex: number): string[] {
    const next = findNextPendingTask(this.tasks);
    if (next !== undefined) {
      return gutterWrappedRows(
        renderTextWithStyles(`Next: ${next.subject}`, { color: Color.muted }) +
          renderTextWithStyles(TASK_LIST_HINT, { color: Color.muted, dim: true }),
        width,
        true,
      );
    }
    return tipRows(tipAt(tipIndex), width);
  }

  /**
   * The planning list of the thread on screen. An agent keeps its tasks under its own
   * fork, so an open agent shows what that fork holds and never the leader's list.
   */
  private scopedTasks(thread: ViewedThread): TaskRecord[] {
    return thread.tasks.filter((task) => !isInternalTask(task));
  }

  /**
   * The list outside a turn. Nothing else occupies the slot then, so it carries its
   * own blank above and below, keeping one clear line against the promptbar.
   */
  private idleTaskRows(width: number, now: number): string[] {
    if (!appStore.getState().view.tasksExpanded) return [];
    const rows = this.taskListRows(width, now, false);
    return rows.length === 0 ? [] : ["", ...rows, ""];
  }

  /**
   * The list in its two forms. Inline it belongs to the turn above it and hangs off the
   * spinner by its gutter. Standalone it belongs to nothing, so it carries a plain
   * indent and opens with a heading — without one its rows read as a continuation of
   * whatever block the transcript happened to end on.
   */
  private taskListRows(width: number, now: number, inline: boolean): string[] {
    const tasks = this.tasks;
    if (tasks.length === 0) return [];
    const maxDisplay = computeMaxTaskRows(process.stdout.rows ?? FALLBACK_TERMINAL_ROWS);
    if (maxDisplay === 0) return [];

    const { visible, hidden } = selectVisibleTasks({
      tasks,
      maxDisplay,
      recentCompletedIds: this.recentCompletions.recentIds(now),
    });
    const unresolved = new Set(
      tasks.filter((task) => task.status !== "completed").map((task) => task.id),
    );
    const activeOwners = new Set(listRunningAgents().map((agent) => agent.agentName));
    const listRows = (text: string, head: boolean): string[] =>
      inline ? gutterWrappedRows(text, width, head) : indentedRows(text, width);

    const rows = inline ? [] : listRows(taskCountsHeader(tasks), false);
    visible.forEach((task, index) => {
      rows.push(
        ...listRows(
          taskRowText({
            task,
            openBlockers: openBlockerIds(task, unresolved),
            activeOwners,
            columns: width,
          }),
          index === 0,
        ),
      );
    });
    const summary = hiddenTaskSummary(hidden);
    if (summary.length > 0) {
      rows.push(...listRows(renderTextWithStyles(summary, { color: Color.muted }), false));
    }
    return rows;
  }

  /**
   * A completion leaving the recency window changes the list with no store
   * event to repaint on, so a one-shot timer targets the soonest expiry. The
   * spinner's frame clock covers a live turn; this covers the idle list.
   */
  private armRecencyRepaint(now: number): void {
    if (this.recencyTimer) clearTimeout(this.recencyTimer);
    this.recencyTimer = undefined;
    const delay = this.recentCompletions.nextExpiryDelay(now);
    const repaint = this.requestRender;
    if (delay === undefined || repaint === undefined) return;
    this.recencyTimer = setTimeout(repaint, delay + 50);
    this.recencyTimer.unref?.();
  }

  private compactBarRow(startedAt: number, now: number): string {
    if (this.compactStartedAt !== startedAt) {
      this.compactStartedAt = startedAt;
      this.displayedCompactRatio = 0;
    }
    const rawRatio = compactProgressRatio(now - startedAt);
    this.displayedCompactRatio = monotonicRatio(this.displayedCompactRatio, rawRatio);
    const parts = compactProgressBarParts(this.displayedCompactRatio);
    return (
      "  " +
      renderTextWithStyles(parts.filled, { color: Color.text }) +
      renderTextWithStyles(parts.empty, { color: Color.text, dim: true }) +
      renderTextWithStyles(` ${parts.percentLabel}`, { color: Color.muted })
    );
  }
}

/**
 * Which planning board the viewed thread reads. The leader's key follows the
 * task-list binding rather than being a constant, so a session rebind (clear,
 * resume) reads as a different board; an agent's key is its own fork. Recency
 * tracking hangs off this: two boards number their tasks alike, and only the
 * key tells the tracker it is no longer watching the list it knew.
 */
function boardKeyFor(thread: ViewedThread): string {
  if (thread.agent === null) return `main:${taskListIdForScope()}`;
  return `agent:${thread.agent.forkId ?? thread.agent.id}`;
}

export function retryProgressRows(status: RetryStatusLine, width: number, now: number): string[] {
  const initialSeconds = Math.max(1, Math.round(status.delayMs / 1_000));
  const elapsedSeconds = Math.max(0, Math.floor((now - status.startedAt) / 1_000));
  const remainingSeconds = Math.max(0, initialSeconds - elapsedSeconds);
  const message = status.message?.trim() || retryMessage(status.reason);
  const headline =
    typeof status.status === "number" ? `HTTP ${status.status}: ${message}` : message;
  const retrying = remainingSeconds > 0 ? `Retrying in ${remainingSeconds}s` : "Retrying";
  const detail = `${retrying} · attempt ${status.attempt}/${status.maxAttempts}`;
  const headlineWidth = Math.max(1, width - 2);
  const headlineRows = wrapOutputRows(
    renderTextWithStyles(headline, { color: Color.error, bold: true }),
    headlineWidth,
  ).map((line, index) => {
    const prefix = index === 0 ? `${Glyph.bullet} ` : "  ";
    return renderTextWithStyles(prefix, { color: Color.error, bold: true }) + line;
  });
  const detailRows = gutterWrappedRows(
    renderTextWithStyles(detail, {
      color: Color.muted,
      dim: remainingSeconds === 0 && Math.floor(now / 500) % 2 !== 0,
    }),
    width,
    true,
  );
  return [...headlineRows, ...detailRows, ""];
}

function retryMessage(reason: string): string {
  if (RATE_LIMIT_PATTERN.test(reason)) return "Rate limited";
  return reason.replace(/^HTTP \d+[^:]*:\s*/, "").slice(0, 200);
}

export function formatThinkingStatus(
  status: "thinking" | number | null,
  effort: EffortLevel | null,
): string {
  if (status === "thinking") {
    return effort === null ? "reasoning with megabrain power" : `reasoning with ${effort} effort`;
  }
  if (typeof status === "number") return `reasoned for ${Math.max(1, Math.round(status / 1_000))}s`;
  return "";
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function syncCounter(current: number, target: number): number {
  if (current === 0 && target > 0) return target;
  if (target <= current) return target;
  const gap = target - current;
  const increment = gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50;
  return Math.min(current + increment, target);
}

function tipRows(tip: string, width: number): string[] {
  if (tip.length === 0) return [];
  return gutterWrappedRows(
    renderTextWithStyles(`Tip: ${tip}`, { color: Color.muted }),
    width,
    true,
  );
}

/** The standalone list's own margin: it hangs off nothing, so it needs no gutter. */
const STANDALONE_INDENT = "  ";

function indentedRows(text: string, width: number): string[] {
  const bodyWidth = Math.max(1, width - STANDALONE_INDENT.length);
  return wrapOutputRows(text, bodyWidth).map((row) => STANDALONE_INDENT + row);
}

function gutterWrappedRows(text: string, width: number, head: boolean): string[] {
  const bodyWidth = Math.max(1, width - stringWidth(GUTTER_CONT));
  const rows = wrapOutputRows(text, bodyWidth);
  return rows.map((row, index) => {
    const gutter = head && index === 0 ? GUTTER_HEAD : GUTTER_CONT;
    return renderTextWithStyles(gutter, { color: Color.muted }) + row;
  });
}
