import {
  pendingAgentSteerCount,
  subscribeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";
import {
  type BackgroundTask,
  list as listBackgroundTasks,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { buildPanelTree } from "@/engine/background/tasks/panel-tree.ts";
import { aggregateSubtreeProgress } from "@/engine/background/tasks/progress.ts";
import {
  listWorkflowTasks,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { computeListWindow } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { formatDuration, formatTokens } from "@/kernel/std/text/format.ts";
import { appStore } from "@/store/app-store/index.ts";
import { overlayStore } from "@/store/overlay-stack/index.ts";
import { isPromptMenuOpen, promptStore } from "@/store/prompt/index.ts";
import { stopConfirmStore } from "@/store/stop-confirm/index.ts";
import { generatorActiveRef } from "@/store/turn-run/index.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { MAX_STATUS_LABEL_WIDTH, MIN_STATUS_LABEL_WIDTH } from "@/ui/chrome/progress/geometry.ts";
import { buildWorkflowRowParts, isFinalWorkflowStatus } from "@/ui/chrome/progress/workflow-row.ts";
import { formatStatusRow } from "@/ui/chrome/status/string-view-row.ts";
import { FALLBACK_TERMINAL_ROWS, listOverflowLine } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { displayNameFor } from "@/ui/transcript/tool-render/args.ts";

const MAX_VISIBLE_ROWS = 5;
const IDLE_NON_PANEL_ROW_RESERVE = 10;
const PANEL_FIXED_ROWS = 2;
const LIVE_TICK_MS = 1_000;
const HEIGHT_SHRINK_HOLD_MS = 3_000;

export interface PanelRowAllocation {
  agentRows: number;
  workflowRows: number;
}

interface AgentStatusParts {
  statusText: string;
  queuedText: string;
}

/** Live footer rows for background agents and workflow runs. */
export class StringViewRunningAgents implements StringComponent {
  private ctx: StringViewContext | undefined;
  private taskUnsub: (() => void) | undefined;
  private workflowUnsub: (() => void) | undefined;
  private steerUnsub: (() => void) | undefined;
  private promptUnsub: (() => void) | undefined;
  private stopConfirmUnsub: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  // Reserve-and-fill: the strip's granted height. Growth claims rows at once;
  // a shrink pads to the reserve and only releases it after the hold, so a
  // regime flip or a finishing agent cannot ratchet the transcript.
  private reservedRows = 0;
  private shrinkStableSince: number | undefined;
  // Regime hysteresis: the expansive idle budget only engages after the main
  // turn has been idle for the hold, so a busy↔idle flicker keeps the busy cap.
  private idleSince: number | undefined;
  // While an overlay is open the strip freezes its last frame: background
  // emits must not change the frame height underneath an open panel.
  private frozenRows: string[] | undefined;
  private frozenWidth: number | undefined;
  // Edge-anchored list windows remember where they start so the frame only
  // slides when the cursor leaves it, never re-centering on every emit.
  private agentWindowStart = 0;
  private workflowWindowStart = 0;

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.ctx = ctx;
    const requestRender = (): void => this.ctx?.requestRender();
    this.taskUnsub = subscribeBackgroundTasks(requestRender);
    this.workflowUnsub = subscribeWorkflowTasks(requestRender);
    this.steerUnsub = subscribeAgentSteers(requestRender);
    this.promptUnsub = promptStore.subscribe(requestRender);
    this.stopConfirmUnsub = stopConfirmStore.subscribe(requestRender);
    this.timer = setInterval(() => {
      if (hasActiveRows() || this.reservedRows > 0) this.ctx?.requestRender();
    }, LIVE_TICK_MS);
  }

  unmount(): void {
    this.taskUnsub?.();
    this.taskUnsub = undefined;
    this.workflowUnsub?.();
    this.workflowUnsub = undefined;
    this.steerUnsub?.();
    this.steerUnsub = undefined;
    this.promptUnsub?.();
    this.promptUnsub = undefined;
    this.stopConfirmUnsub?.();
    this.stopConfirmUnsub = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx = undefined;
    this.reservedRows = 0;
    this.shrinkStableSince = undefined;
    this.agentWindowStart = 0;
    this.workflowWindowStart = 0;
  }

  render(width: number): string[] {
    // The command-menu displacement outranks the overlay freeze: the band is
    // the menu's while it is open, whatever else the frame carries.
    if (
      !isPromptMenuOpen() &&
      overlayStore.getState().openStack.length > 0 &&
      this.frozenRows !== undefined &&
      this.frozenWidth === width
    ) {
      return this.frozenRows;
    }
    const rows = this.heldAtReserve(this.renderRows(width), Date.now());
    this.frozenRows = rows;
    this.frozenWidth = width;
    return rows;
  }

  /**
   * A frame shorter than the reserve pads up to it and starts the release
   * clock; only a hold of stable shrinkage lets the reserve follow. Growth
   * claims the taller frame immediately and resets the clock.
   */
  private heldAtReserve(rows: string[], now: number): string[] {
    if (rows.length >= this.reservedRows) {
      this.reservedRows = rows.length;
      this.shrinkStableSince = undefined;
      return rows;
    }
    if (this.shrinkStableSince === undefined) this.shrinkStableSince = now;
    if (now - this.shrinkStableSince >= HEIGHT_SHRINK_HOLD_MS) {
      this.reservedRows = rows.length;
      this.shrinkStableSince = undefined;
      return rows;
    }
    const padded = rows.slice();
    while (padded.length < this.reservedRows) padded.push("");
    return padded;
  }

  private renderRows(width: number): string[] {
    // These rows sit in the same band the command menu takes over, and they close
    // the footer the menu already hides — so they leave with it. The menu swap is
    // deliberate displacement, not churn: the reserve resets with it.
    if (isPromptMenuOpen()) {
      this.reservedRows = 0;
      this.shrinkStableSince = undefined;
      return [];
    }
    const allBackgroundTasks = listBackgroundTasks();
    const view = appStore.getState().view;
    // The tree opens along the viewed document: children of the task being read
    // (plus its ancestor chain) join the list; everything else collapses into
    // its root's (+N) badge. The cursor never changes the tree — only opening
    // a document does.
    const panelAgents = visiblePanelAgents(allBackgroundTasks, view.viewingAgentId ?? undefined);
    const workflows = activeWorkflows();
    // While an agent's document is open, this list is the only way back to the main
    // thread. The agent being read finishes on its own schedule, so a list that leaves
    // when the work stops would take the way out with it.
    const viewingAgent = view.viewingAgentId !== null;
    if (panelAgents.length === 0 && workflows.length === 0 && !viewingAgent) return [];

    const now = Date.now();
    const busy = generatorActiveRef.current;
    if (busy) {
      this.idleSince = undefined;
    } else if (this.idleSince === undefined) {
      this.idleSince = now;
    }
    const expansiveIdle = !busy && now - (this.idleSince ?? now) >= HEIGHT_SHRINK_HOLD_MS;
    const allocation = panelRowAllocation(
      this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS,
      !expansiveIdle,
      panelAgents.length,
      workflows.length,
    );
    const rows: string[] = [];
    const hasMainRow = panelAgents.length > 0 || viewingAgent;

    // One label column across every row: connector + name + badge widths set
    // it, clamped so a long name cannot push the descriptions off screen.
    const labelWidth = panelLabelWidth(panelAgents, workflows, now);

    // Each namespace scrolls its own edge-anchored window: the frame holds
    // still until the cursor steps past it, then slides just far enough.
    const selectedAgentIdx =
      view.panelFocused && view.panelSelection >= 1 && view.panelSelection <= panelAgents.length
        ? view.panelSelection - 1
        : -1;
    const agentWindow = computeListWindow({
      cursor: selectedAgentIdx,
      total: panelAgents.length,
      size: allocation.agentRows,
      anchor: "edge",
      previousStart: this.agentWindowStart,
    });
    this.agentWindowStart = agentWindow.from;

    if (hasMainRow) {
      rows.push(
        renderMainRow(
          width,
          view.panelFocused && view.panelSelection === 0,
          view.viewingAgentId === null,
          agentWindow.above,
        ),
      );
    }
    for (let index = agentWindow.from; index < agentWindow.to; index++) {
      const task = panelAgents[index]!;
      rows.push(
        renderAgentRow(
          task,
          allBackgroundTasks,
          now,
          width,
          view.panelFocused && view.panelSelection === index + 1,
          view.viewingAgentId === task.id,
          connectorFor(task, panelAgents, index, agentWindow.from),
          labelWidth,
        ),
      );
    }
    if (agentWindow.below > 0) rows.push(listOverflowLine("down", agentWindow.below, undefined, 2));

    const selectedWorkflowIdx = view.panelFocused
      ? view.panelSelection - (hasMainRow ? panelAgents.length + 1 : 0)
      : -1;
    const workflowWindow = computeListWindow({
      cursor: selectedWorkflowIdx,
      total: workflows.length,
      size: allocation.workflowRows,
      anchor: "edge",
      previousStart: this.workflowWindowStart,
    });
    this.workflowWindowStart = workflowWindow.from;
    if (workflowWindow.above > 0)
      rows.push(listOverflowLine("up", workflowWindow.above, undefined, 2));
    for (let index = workflowWindow.from; index < workflowWindow.to; index++) {
      rows.push(
        renderWorkflowRow(workflows[index]!, now, width, selectedWorkflowIdx === index, labelWidth),
      );
    }
    if (workflowWindow.below > 0) {
      rows.push(listOverflowLine("down", workflowWindow.below, undefined, 2));
    }

    return [...rows, ""];
  }
}

export function visiblePanelAgents(
  allTasks: BackgroundTask[],
  focusedTaskId?: string,
): BackgroundTask[] {
  // Finished rows stay listed — "Enter to view · x to clear" — until the store
  // evicts them; the strip never outlives the store's memory of the run.
  const candidates = allTasks.filter(
    (task) => task.kind === "agent" && task.isBackgrounded && !task.isSidechain,
  );
  return buildPanelTree(candidates, focusedTaskId).orderedVisibleNodes.map((node) => ({
    ...node.task,
    depth: node.depth,
    hasLaterSibling: node.hasLaterSibling,
    transitiveHiddenCount: node.transitiveHiddenCount,
  }));
}

/**
 * A nested row whose parent scrolled above the window keeps its gutter as a
 * continuation (├, never the closing └), so the branch reads as carried over
 * the fold.
 */
function connectorFor(
  task: BackgroundTask,
  ordered: readonly BackgroundTask[],
  index: number,
  windowStart: number,
): string {
  if (!task.depth || task.depth <= 1) return "";
  for (let j = index - 1; j >= 0; j--) {
    if ((ordered[j]?.depth ?? 1) < task.depth) {
      if (j < windowStart) return "  ".repeat(Math.max(0, task.depth - 2)) + "├ ";
      break;
    }
  }
  return agentConnector(task);
}

export function activeWorkflows(): WorkflowTaskLifecycle[] {
  return listWorkflowTasks().filter((task) => !isFinalWorkflowStatus(task.status));
}

function hasActiveRows(): boolean {
  return (
    listBackgroundTasks().some(
      (task) =>
        task.kind === "agent" &&
        task.isBackgrounded &&
        !task.isSidechain &&
        task.status === "running",
    ) || activeWorkflows().length > 0
  );
}

export function panelRowAllocation(
  terminalRows: number,
  mainLlmBusy: boolean,
  agentCount: number,
  workflowCount: number,
): PanelRowAllocation {
  // The agent list holds a fixed five-row window in every regime; the sliding
  // window and its overflow markers carry the rest. Workflows have no such
  // fixed window and spend the idle budget the screen affords.
  if (mainLlmBusy) {
    return {
      agentRows: Math.min(agentCount, MAX_VISIBLE_ROWS),
      workflowRows: Math.min(workflowCount, MAX_VISIBLE_ROWS),
    };
  }

  const contentRows = Math.max(0, terminalRows - IDLE_NON_PANEL_ROW_RESERVE);
  const mainRows = agentCount > 0 ? 1 : 0;
  // Agent overflow above rides on the pinned main row, so agents spend at most
  // one marker row. Workflows render independent markers on both sides.
  const overflowRows = (agentCount > 0 ? 1 : 0) + (workflowCount > 0 ? 2 : 0);
  const listRows = Math.max(0, contentRows - PANEL_FIXED_ROWS - mainRows - overflowRows);
  const agentRows = Math.min(agentCount, MAX_VISIBLE_ROWS, listRows);
  return {
    agentRows,
    workflowRows: Math.min(workflowCount, Math.max(0, listRows - agentRows)),
  };
}

// The open document's row carries the filled bullet; every other row is hollow.
function documentBullet(viewed: boolean): string {
  return viewed ? Glyph.bullet : Glyph.bulletHollow;
}

/**
 * Row colour law: a row the reader is neither on nor inside renders dim; the
 * selected row lifts the dim; the viewed row (the open document) renders bold.
 * Colour only ever marks status — the cursor and the text carry weight, not hue.
 */
function renderMainRow(
  width: number,
  selected: boolean,
  viewed: boolean,
  moreAbove: number,
): string {
  const left = renderTextWithStyles(`${documentBullet(viewed)} main`, {
    dim: !selected && !viewed,
    bold: viewed,
  });
  // Rows scrolled past the top announce themselves on the main row's right —
  // the row that never scrolls — instead of spending a marker row.
  const right =
    moreAbove > 0
      ? renderTextWithStyles(`${Glyph.arrowUp} ${moreAbove} more`, { color: Color.muted })
      : undefined;
  return cursorLane(formatStatusRow(left, width, right), selected, viewed);
}

function renderAgentRow(
  task: BackgroundTask,
  allTasks: readonly BackgroundTask[],
  now: number,
  width: number,
  selected: boolean,
  viewed: boolean,
  connector: string,
  labelWidth: number,
): string {
  const status = buildAgentStatus(task, allTasks, now);
  const dim = !selected && !viewed;
  const statusColor = agentStatusColor(task);
  const label = singleLine(agentRowLabel(task));
  const badge = hiddenSuffix(task);
  const fill = labelColumnFill(
    labelWidth,
    stringWidth(connector) + stringWidth(label) + stringWidth(badge),
  );
  const left =
    renderTextWithStyles(connector, { dim }) +
    renderTextWithStyles(
      `${documentBullet(viewed)} `,
      statusColor === undefined ? { dim, bold: viewed } : { color: statusColor, bold: viewed },
    ) +
    renderTextWithStyles(label, { dim, bold: viewed }) +
    renderTextWithStyles(badge, { dim: true }) +
    fill +
    descriptionSuffix(task.description, { dim, bold: viewed });
  const right =
    stopConfirmMessage(task) ??
    renderTextWithStyles(status.statusText, { dim, bold: viewed }) +
      (status.queuedText.length > 0
        ? renderTextWithStyles(` · ${status.queuedText}`, { color: Color.warning })
        : "");
  return cursorLane(formatStatusRow(left, width, right), selected, viewed);
}

/**
 * The cursor lane is the row's own left padding: pointing at a row lights the
 * lane without shifting the row. The pointer carries the row's weight — bold on
 * the viewed row, plain elsewhere — never a colour of its own.
 */
function cursorLane(row: string, selected: boolean, viewed: boolean): string {
  if (!selected) return row;
  return renderTextWithStyles(Glyph.chevron, { bold: viewed }) + row.slice(Glyph.chevron.length);
}

function renderWorkflowRow(
  task: WorkflowTaskLifecycle,
  now: number,
  width: number,
  selected: boolean,
  labelWidth: number,
): string {
  const parts = buildWorkflowRowParts(task, now);
  const name = singleLine(parts.name);
  const left =
    renderTextWithStyles(`${Glyph.bulletHollow} `, {
      ...(parts.bulletColor === undefined ? { dim: true } : { color: parts.bulletColor }),
    }) +
    renderTextWithStyles(name, { dim: !selected }) +
    labelColumnFill(labelWidth, stringWidth(name)) +
    descriptionSuffix(parts.description, { dim: !selected });
  const right = renderTextWithStyles(parts.statusText, { dim: !selected });
  return cursorLane(formatStatusRow(left, width, right), selected, false);
}

/**
 * Shared label column: names and badges land in one column and every
 * description starts at the next one, whatever the row's depth.
 */
function panelLabelWidth(
  agents: readonly BackgroundTask[],
  workflows: readonly WorkflowTaskLifecycle[],
  now: number,
): number {
  const agentWidths = agents.map(
    (task) =>
      stringWidth(agentConnector(task)) +
      stringWidth(singleLine(agentRowLabel(task))) +
      stringWidth(hiddenSuffix(task)),
  );
  const workflowWidths = workflows.map((task) =>
    stringWidth(singleLine(buildWorkflowRowParts(task, now).name)),
  );
  return clamp(
    Math.max(0, ...agentWidths, ...workflowWidths),
    MIN_STATUS_LABEL_WIDTH,
    MAX_STATUS_LABEL_WIDTH,
  );
}

function labelColumnFill(labelWidth: number, usedWidth: number): string {
  return " ".repeat(Math.max(0, labelWidth - usedWidth) + 1);
}

function buildAgentStatus(
  task: BackgroundTask,
  allTasks: readonly BackgroundTask[],
  now: number,
): AgentStatusParts {
  const isRunning = task.status === "running";
  // A parked fork's elapsed freezes at the park moment: its turn is over even
  // though the task stays alive waiting on owned background work.
  const endRef = isRunning ? (task.parkedAt ?? now) : (task.endedAt ?? task.startedAt);
  const elapsed = formatDuration(Math.max(0, endRef - task.startedAt));
  const byId = new Map(allTasks.map((entry) => [entry.id, entry]));
  byId.set(task.id, task);
  const progress = aggregateSubtreeProgress(task.id, [...byId.values()]);
  const parts = [elapsed];
  if (progress.tokenCount > 0) {
    parts.push(`${isRunning ? "↓" : "↑"} ${formatTokens(progress.tokenCount)} tokens`);
  }
  const queuedCount =
    isRunning && task.forkId !== undefined ? pendingAgentSteerCount(task.forkId) : 0;
  return {
    statusText: parts.join(" · "),
    queuedText: queuedCount > 0 ? `${queuedCount} queued` : "",
  };
}

/**
 * The row's label is the agent's type; descriptions tell two agents of one type
 * apart. A task with no resolvable type keeps its given name.
 */
function agentRowLabel(task: BackgroundTask): string {
  const typeId = task.agentId;
  if (typeId === undefined || typeId.length === 0) return task.agentName;
  const label = displayNameFor("Agent", { subagent_type: typeId });
  return label.length === 0 ? task.agentName : label;
}

function descriptionSuffix(
  description: string | undefined,
  styles: { dim: boolean; bold?: boolean },
): string {
  const text = description === undefined ? "" : singleLine(description);
  return text.length === 0 ? "" : renderTextWithStyles(`  ${text}`, styles);
}

/**
 * The armed row's right side names the confirming press. The first press on a
 * live run also stopped it, and the message says so; on a settled row only the
 * close remains.
 */
function stopConfirmMessage(task: BackgroundTask): string | null {
  const armed = stopConfirmStore.getState();
  if (armed.taskId !== task.id) return null;
  const message = armed.justStopped ? "stopped · x again to close" : "x again to close";
  return renderTextWithStyles(message, { color: Color.error });
}

// A resolved outcome owns the bullet's colour; a live row follows the row's weight.
function agentStatusColor(task: BackgroundTask) {
  if (task.status === "completed") return Color.success;
  if (task.status === "error" || task.status === "killed") return Color.error;
  return undefined;
}

function agentConnector(task: BackgroundTask): string {
  return task.depth && task.depth > 1
    ? "  ".repeat(task.depth - 2) + (task.hasLaterSibling ? "├" : "└") + " "
    : "";
}

function hiddenSuffix(task: BackgroundTask): string {
  return task.transitiveHiddenCount && task.transitiveHiddenCount > 0
    ? ` (+${task.transitiveHiddenCount})`
    : "";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
