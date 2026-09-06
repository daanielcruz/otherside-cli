import {
  type BackgroundTask,
  get as getBackgroundTask,
  holdTaskEviction,
  list as listBackgroundTasks,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { panelKey, panelLeaves } from "@/ui/chrome/panel-keys.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  listOverflowLine,
  renderFooterPanel,
} from "@/ui/chrome/string-view-panel.ts";
import {
  armCtrlXChord,
  isCtrlXPrefix,
  releaseCtrlXChord,
  takeCtrlXChord,
} from "@/ui/input/ctrl-x-chord.ts";
import {
  agentDetailLines,
  detailFooterHints,
  shellDetailLines,
} from "@/ui/panels/background-tasks/detail-lines.ts";
import { killAllRunningAgents, killTask } from "@/ui/panels/background-tasks/task-actions.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

const POLL_MS = 1000;
const PANEL_PAD_X = 2;
const WINDOW_MIN_TASK_ROWS = 3;

type PanelProps = {
  tasks?: BackgroundTask[];
  onForeground?: (task: BackgroundTask) => void;
};

/**
 * Live background-task list on the string model. Subscribes to the task store and
 * polls so elapsed clocks advance. Enter opens a per-task detail view; `x` stops the
 * selected task; `ctrl+x ctrl+k` stops the running agents; Escape/← closes.
 */
class BackgroundTasksPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private releaseHold: (() => void) | undefined;
  private cursor = 0;
  /** Task rows the last frame showed at once; the page keys step by this. */
  private pageRows = 1;
  private detailId: string | null = null;
  private readonly onForeground: ((task: BackgroundTask) => void) | undefined;
  private readonly tasksOverride: BackgroundTask[] | undefined;

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    const p = narrowProps(props);
    this.tasksOverride = p.tasks;
    this.onForeground = p.onForeground;
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.unsub = subscribeBackgroundTasks(() => {
      this.clampSelection();
      this.ctx?.requestRender();
    });
    this.timer = setInterval(() => this.ctx?.requestRender(), POLL_MS);
    const tasks = this.visibleTasks();
    if (tasks.length === 1) this.setDetail(tasks[0]?.id ?? null);
    else this.clampSelection();
    ctx.requestRender();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.releaseHold?.();
    this.releaseHold = undefined;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const tasks = this.visibleTasks();
    const detail = this.detailTask(tasks);
    if (detail) return this.renderDetail(detail, width);
    return this.renderList(tasks, width);
  }

  handleKey(key: KeyEventData): void {
    const tasks = this.visibleTasks();
    const detail = this.detailTask(tasks);

    if (isCtrlXPrefix(key)) {
      armCtrlXChord();
      return;
    }
    if (key.ctrl && key.name === "k" && takeCtrlXChord()) {
      const killed = killAllRunningAgents(tasks);
      if (killed > 0 && tasks.length === 1) this.close();
      else this.ctx?.requestRender();
      return;
    }
    releaseCtrlXChord();

    if (detail) {
      this.handleDetailKey(key, detail, tasks.length === 1);
      return;
    }

    const action = listSelectKey(key, {
      cursor: this.cursor,
      count: tasks.length,
      pageSize: this.pageRows,
    });
    if (action !== undefined) {
      this.cursor = action.cursor;
      if (action.activate) {
        const picked = tasks[this.cursor];
        if (picked) this.setDetail(picked.id);
        return;
      }
      this.ctx?.requestRender();
      return;
    }

    switch (key.name) {
      case "return": {
        const task = tasks[this.cursor];
        if (task) this.setDetail(task.id);
        return;
      }
      case "escape":
        this.close();
        return;
    }

    if (key.sequence === "f") {
      const task = tasks[this.cursor];
      if (task?.kind === "agent" && this.onForeground) this.onForeground(task);
      return;
    }
    if (key.sequence === "x") {
      const task = tasks[this.cursor];
      if (task) killTask(task);
      this.clampSelection();
      this.ctx?.requestRender();
    }
  }

  private handleDetailKey(key: KeyEventData, task: BackgroundTask, single: boolean): void {
    if (key.name === "left") {
      if (single) this.close();
      else this.setDetail(null);
      return;
    }
    // A detail view with nothing to take: confirm and toggle leave as well.
    const panelAction = panelKey(key);
    if (panelLeaves(key) || panelAction === "confirm" || panelAction === "toggle") {
      this.close();
      return;
    }
    if (key.sequence === "f" && task.kind === "agent" && this.onForeground) {
      this.onForeground(task);
      return;
    }
    if (key.sequence === "x") {
      killTask(task);
      if (single) this.close();
      else this.setDetail(null);
    }
  }

  private renderList(tasks: BackgroundTask[], width: number): string[] {
    const focused = tasks[this.cursor];

    const footerHints: [string, string][] =
      tasks.length === 0
        ? [["Esc", "to close"]]
        : [
            ["↑/↓", "to select"],
            ["Enter", "to view"],
            ["x", "to stop"],
            ...(focused?.kind === "agent"
              ? ([["ctrl+x ctrl+k", "to stop all agents"]] as [string, string][])
              : []),
            ["Esc", "to close"],
          ];

    const spec: FooterPanelSpec = {
      command: "/tasks",
      title: "Background",
      footerHints,
      flushTop: true,
      body: [],
    };
    const contentWidth = Math.max(1, width - PANEL_PAD_X * 2);
    spec.body =
      tasks.length === 0
        ? [renderTextWithStyles("no active background tasks", { color: Color.muted })]
        : this.listBodyLines(
            tasks,
            contentWidth,
            footerPanelBodyBudget(spec, this.terminalRows(), width),
          );
    return renderFooterPanel(spec, width);
  }

  /**
   * Body in the shared panel frame: per-type count line, then one section per
   * task kind (headers only when more than one kind is on screen). Only task
   * rows window under the row budget; the decoration stays put so the counts
   * and section names never scroll away.
   */
  private listBodyLines(tasks: BackgroundTask[], contentWidth: number, budget: number): string[] {
    const shells = tasks.filter((task) => task.kind === "shell");
    const agents = tasks.filter((task) => task.kind === "agent");
    const sections = [
      { header: `Shells (${shells.length})`, tasks: shells },
      { header: `Local agents (${agents.length})`, tasks: agents },
    ].filter((section) => section.tasks.length > 0);
    const showHeaders = sections.length > 1;

    const decorationRows =
      2 + (showHeaders ? sections.length : 0) + Math.max(0, sections.length - 1);
    const size = Math.max(WINDOW_MIN_TASK_ROWS, budget - decorationRows);
    const overflow = tasks.length > size;
    const windowSize = overflow ? Math.max(1, size - 2) : size;
    this.pageRows = windowSize;
    const window = computeListWindow({
      cursor: Math.min(this.cursor, Math.max(0, tasks.length - 1)),
      total: tasks.length,
      size: windowSize,
      anchor: "bottom",
    });

    const lines: string[] = [countLine(shells.length, agents.length), ""];
    if (overflow && window.above > 0) lines.push(listOverflowLine("up", window.above, "above"));
    let flatIndex = 0;
    let renderedSections = 0;
    for (const section of sections) {
      const rows: string[] = [];
      for (const task of section.tasks) {
        const index = flatIndex++;
        if (index < window.from || index >= window.to) continue;
        rows.push(this.taskRowLine(task, index === this.cursor, contentWidth));
      }
      if (rows.length === 0) continue;
      if (renderedSections > 0) lines.push("");
      if (showHeaders) {
        lines.push(`  ${renderTextWithStyles(section.header, { color: Color.muted })}`);
      }
      lines.push(...rows);
      renderedSections += 1;
    }
    if (overflow && window.below > 0) lines.push(listOverflowLine("down", window.below, "below"));
    return lines;
  }

  private taskRowLine(task: BackgroundTask, selected: boolean, contentWidth: number): string {
    const label =
      task.kind === "shell"
        ? (task.command ?? task.description ?? task.id)
        : (task.description ?? task.agentName);
    const status = ` (${task.status})`;
    const marker = selected ? Glyph.chevron : "  ";
    const labelWidth = Math.max(1, contentWidth - stringWidth(marker) - stringWidth(status));
    return (
      renderTextWithStyles(marker, { color: selected ? Color.panelAccent : Color.muted }) +
      renderTextWithStyles(cellClip(label, labelWidth), {
        color: selected ? Color.panelAccent : Color.text,
        bold: selected,
      }) +
      renderTextWithStyles(status, { color: Color.muted })
    );
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private renderDetail(task: BackgroundTask, width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const body =
      task.kind === "shell"
        ? shellDetailLines(task, contentWidth)
        : agentDetailLines(task, contentWidth);

    const spec: FooterPanelSpec = {
      command: "/tasks",
      footerHints: detailFooterHints(task, this.onForeground),
      flushTop: true,
      body,
    };
    return renderFooterPanel(spec, width);
  }

  private visibleTasks(): BackgroundTask[] {
    if (this.tasksOverride !== undefined) {
      // Prefer live store rows for matching ids so status/elapsed stay current.
      const live = new Map(listBackgroundTasks().map((task) => [task.id, task]));
      const merged = this.tasksOverride.map((task) => live.get(task.id) ?? task);
      return backgroundPanelTasksInDisplayOrder(merged);
    }
    return backgroundPanelTasksInDisplayOrder(
      listBackgroundTasks().filter((task) => task.isBackgrounded && task.status === "running"),
    );
  }

  private detailTask(tasks: BackgroundTask[]): BackgroundTask | null {
    if (!this.detailId) return null;
    return (
      tasks.find((task) => task.id === this.detailId) ?? getBackgroundTask(this.detailId) ?? null
    );
  }

  private setDetail(id: string | null): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
    this.detailId = id;
    if (id) this.releaseHold = holdTaskEviction(id);
    this.ctx?.requestRender();
  }

  private clampSelection(): void {
    const tasks = this.visibleTasks();
    // Keep detail open while the held task still exists in the store (eviction
    // is paused via holdTaskEviction); only drop when the task is gone entirely.
    if (this.detailId && !tasks.some((task) => task.id === this.detailId)) {
      if (!getBackgroundTask(this.detailId)) {
        this.setDetail(tasks.length === 1 ? (tasks[0]?.id ?? null) : null);
      }
    }
    if (tasks.length === 0) {
      this.cursor = 0;
      return;
    }
    if (this.cursor >= tasks.length) this.cursor = tasks.length - 1;
    if (this.cursor < 0) this.cursor = 0;
  }
}

function backgroundPanelTasksInDisplayOrder(tasks: BackgroundTask[]): BackgroundTask[] {
  return [
    ...tasks.filter((task) => task.kind === "shell"),
    ...tasks.filter((task) => task.kind === "agent").sort((a, b) => b.startedAt - a.startedAt),
  ];
}

/** Per-type population line, shells before agents. */
function countLine(shells: number, agents: number): string {
  const parts: string[] = [];
  if (shells > 0) parts.push(`${shells} active shell${shells === 1 ? "" : "s"}`);
  if (agents > 0) parts.push(`${agents} active agent${agents === 1 ? "" : "s"}`);
  return renderTextWithStyles(parts.join(" · "), { color: Color.text });
}

function narrowProps(props: unknown): PanelProps {
  if (!props || typeof props !== "object") return {};
  const record = props as Record<string, unknown>;
  const out: PanelProps = {};
  if (Array.isArray(record.tasks)) out.tasks = record.tasks as BackgroundTask[];
  if (typeof record.onForeground === "function") {
    out.onForeground = record.onForeground as (task: BackgroundTask) => void;
  }
  return out;
}

export function createBackgroundTasksPanel(close: () => void, props?: unknown): StringViewPanel {
  return new BackgroundTasksPanel(close, props);
}
