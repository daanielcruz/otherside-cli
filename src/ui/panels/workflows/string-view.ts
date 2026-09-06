import { getActiveSessionId } from "@/engine/background/tasks/output-files.ts";
import {
  loadWorkflowHistory,
  type WorkflowSnapshot,
} from "@/engine/background/workflows/runtime/history/snapshot.ts";
import type { MergedPhase } from "@/engine/background/workflows/runtime/progress/merge.ts";
import {
  buildWorkflowResumeCall,
  killWorkflowTask,
  listWorkflowTasks,
  pauseWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { findGitRoot } from "@/kernel/std/fs/git-root.ts";
import { clamp } from "@/kernel/std/math.ts";
import { getPromptText, setPromptText } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { panelKey, panelLeaves } from "@/ui/chrome/panel-keys.ts";
import { FALLBACK_TERMINAL_ROWS, renderFooterPanel } from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import type { DetailLevel } from "@/ui/panels/types.ts";
import {
  type AgentFilter,
  filterAgents,
  nextAgentFilter,
} from "@/ui/panels/workflows/agent-filter.ts";
import { renderWorkflowDetail } from "@/ui/panels/workflows/detail.ts";
import { workflowDetailKey } from "@/ui/panels/workflows/detail-keys.ts";
import {
  agentStatusLabel,
  isPromptExpandable,
  mergedPhases,
  mergeItems,
  type WorkflowListItem,
} from "@/ui/panels/workflows/items.ts";
import { renderWorkflowList, workflowListPageSize } from "@/ui/panels/workflows/list.ts";
import {
  openSaveForm,
  renderSaved,
  renderSaveError,
  renderSaveScopePicker,
  type SaveFormState,
  type SaveScope,
  saveFormKey,
  saveWorkflowScript,
} from "@/ui/panels/workflows/save.ts";
import { Color } from "@/ui/theme/theme.ts";

const POLL_MS = 1000;

type ViewMode =
  | { mode: "list" }
  | { mode: "detail"; itemId: string }
  | { mode: "save"; itemId: string }
  | { mode: "saved"; path: string }
  | { mode: "save-error"; itemId: string; path: string };

type PanelProps = {
  sessionId?: string;
  cwd?: string;
  initialDetailItemId?: string;
};

/**
 * Live workflow manager on the string model. Subscribes to the workflow task store,
 * merges disk history for the current session, and drills list → phases → agents →
 * agent detail. This file owns the panel's state and keys; each view renders from its
 * own module so the state machine stays readable.
 */
class WorkflowsPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor = 0;
  /** List rows the last frame showed at once; the page keys step by this. */
  private pageRows = 1;
  private history: WorkflowSnapshot[] = [];
  private loading = true;
  private liveIdsKey = "";
  private view: ViewMode;
  private saveForm: SaveFormState = openSaveForm(undefined);
  private detailLevel: DetailLevel = "phases";
  private phaseCursor = 0;
  private agentCursor = 0;
  private cardScroll = 0;
  private agentFilter: AgentFilter = "all";
  private expandedPrompts = new Set<string>();
  private autoOpened = false;
  private readonly directDetail: boolean;
  private readonly sessionIdHint: string | undefined;
  private readonly cwdHint: string | undefined;
  private readonly projectRoot: string;

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    const p = narrowProps(props);
    this.sessionIdHint = p.sessionId;
    this.cwdHint = p.cwd;
    this.projectRoot = findGitRoot(this.cwd()) ?? this.cwd();
    this.directDetail = p.initialDetailItemId !== undefined;
    this.view = p.initialDetailItemId
      ? { mode: "detail", itemId: p.initialDetailItemId }
      : { mode: "list" };
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.unsub = subscribeWorkflowTasks(() => {
      this.clampListCursor();
      // Reload history only when the live id set changes so a completed task
      // that just evicted can fall back to a fresh disk snapshot.
      const nextKey = listWorkflowTasks()
        .map((task) => task.workflowRunId)
        .join(",");
      if (nextKey !== this.liveIdsKey) {
        this.liveIdsKey = nextKey;
        void this.reloadHistory();
      }
      this.ctx?.requestRender();
    });
    this.timer = setInterval(() => {
      if (this.hasRunning()) this.ctx?.requestRender();
    }, POLL_MS);
    this.liveIdsKey = listWorkflowTasks()
      .map((task) => task.workflowRunId)
      .join(",");
    void this.reloadHistory();
    this.clampListCursor();
    ctx.requestRender();
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx = undefined;
  }

  /**
   * The detail is a document about one run, so it takes the screen; the list is a
   * chooser and stays in the footer, where the conversation and the prompt remain
   * in view behind it.
   */
  fullscreen(): boolean {
    return this.view.mode === "detail";
  }

  render(width: number): string[] {
    const items = this.items();
    this.maybeAutoOpen(items);
    this.clampListCursor(items.length);
    const rows = this.terminalRows();

    if (this.view.mode === "saved") return renderSaved(this.view.path, rows, width);
    if (this.view.mode === "save-error") return renderSaveError(this.view.path, rows, width);
    if (this.view.mode === "save") {
      const { itemId } = this.view;
      return renderSaveScopePicker({
        item: items.find((candidate) => candidate.id === itemId),
        name: this.saveForm.name,
        field: this.saveForm.field,
        scope: this.saveForm.scope,
        projectRoot: this.projectRoot,
        terminalRows: rows,
        width,
      });
    }
    if (this.view.mode === "detail") {
      const { itemId } = this.view;
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return this.renderMissingWorkflow(width);
      const detail = renderWorkflowDetail({
        item,
        state: {
          detailLevel: this.detailLevel,
          phaseCursor: this.phaseCursor,
          agentCursor: this.agentCursor,
          cardScroll: this.cardScroll,
          expandedPrompts: this.expandedPrompts,
          agentFilter: this.agentFilter,
        },
        terminalRows: rows,
        width,
      });
      this.phaseCursor = detail.phaseCursor;
      this.agentCursor = detail.agentCursor;
      this.cardScroll = detail.cardScroll;
      return detail.lines;
    }
    const list = { items, cursor: this.cursor, loading: this.loading, terminalRows: rows };
    this.pageRows = workflowListPageSize(list);
    return renderWorkflowList({ ...list, width });
  }

  handleKey(key: KeyEventData): void {
    const items = this.items();
    this.clampListCursor(items.length);

    if (this.view.mode === "saved") {
      this.view = { mode: "list" };
      this.ctx?.requestRender();
      return;
    }
    if (this.view.mode === "save-error") {
      this.view = { mode: "save", itemId: this.view.itemId };
      this.ctx?.requestRender();
      return;
    }
    if (this.view.mode === "save") {
      this.handleSaveKey(key, items);
      return;
    }
    if (this.view.mode === "detail") {
      const { itemId } = this.view;
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) {
        if (panelLeaves(key)) this.goBackFromDetail(items.length);
        return;
      }
      this.handleDetailKey(key, item, items.length);
      return;
    }

    const move = listSelectKey(key, {
      cursor: this.cursor,
      count: items.length,
      pageSize: this.pageRows,
    });
    if (move !== undefined) {
      this.cursor = move.cursor;
      if (move.activate) {
        const picked = items[this.cursor];
        if (picked) this.openDetail(picked.id);
        return;
      }
      this.ctx?.requestRender();
      return;
    }

    switch (key.name) {
      case "return": {
        const selected = items[this.cursor];
        if (selected) this.openDetail(selected.id);
        return;
      }
      case "escape":
      case "left":
        this.close();
        return;
    }

    const selected = items[this.cursor];
    if (key.sequence === "x" && selected) {
      if (selected.status === "running") pauseWorkflowTask(selected.id);
      else if (selected.status === "paused") killWorkflowTask(selected.id, true);
      this.ctx?.requestRender();
      return;
    }
    if (key.sequence === "s" && selected && selected.script.length > 0) {
      this.openSave(selected.id);
      return;
    }
    if (key.sequence === "q") this.close();
  }

  private renderMissingWorkflow(width: number): string[] {
    return renderFooterPanel(
      {
        command: "/workflows",
        title: "Dynamic workflows",
        maxRows: this.terminalRows(),
        footerHints: [["Esc", "back"]],
        body: [renderTextWithStyles("Workflow not found.", { color: Color.muted })],
      },
      width,
    );
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private handleSaveKey(key: KeyEventData, items: WorkflowListItem[]): void {
    if (this.view.mode !== "save") return;
    const { itemId } = this.view;
    if (panelLeaves(key)) {
      this.view = { mode: "detail", itemId };
      this.ctx?.requestRender();
      return;
    }
    const nextForm = saveFormKey(this.saveForm, key);
    if (nextForm !== null) {
      this.saveForm = nextForm;
      this.ctx?.requestRender();
      return;
    }
    if (panelKey(key) === "confirm") {
      const item = items.find((candidate) => candidate.id === itemId);
      if (item) void this.saveTo(item, this.saveForm.scope);
    }
  }

  private handleDetailKey(key: KeyEventData, item: WorkflowListItem, itemCount: number): void {
    const phases = mergedPhases(item);
    const phase = phases[clamp(this.phaseCursor, 0, Math.max(0, phases.length - 1))];
    const workflowActive = item.status === "running";
    // Keys act on the row the reader sees, so they address the filtered set the
    // render drew — never the phase's full roster behind it.
    const agents = filterAgents({
      agents: phase?.agents ?? [],
      filter: this.agentFilter,
      workflowActive,
    });
    const agent = agents[clamp(this.agentCursor, 0, Math.max(0, agents.length - 1))];
    const agentStatus = agent ? agentStatusLabel({ agent, workflowActive }) : undefined;

    const action = workflowDetailKey(key, {
      detailLevel: this.detailLevel,
      agent,
      phaseHasAgents: (phase?.agents.length ?? 0) > 0,
      workflowActive,
      canResume: item.status === "paused" && item.scriptPath !== undefined,
      canControlAgent:
        workflowActive &&
        this.detailLevel === "agent" &&
        agent?.agentId !== undefined &&
        agentStatus === "running",
      promptExpandable: this.detailLevel === "agent" && agent ? isPromptExpandable(agent) : false,
      hasScript: item.script.length > 0,
    });
    if (action === undefined) return;

    switch (action.kind) {
      case "move-cursor":
        this.moveCursor(action.delta, phases, workflowActive);
        return;
      case "move-card":
        this.moveCard(action.delta);
        return;
      case "enter-agents":
        this.agentCursor = 0;
        this.cardScroll = 0;
        this.detailLevel = "agents";
        this.ctx?.requestRender();
        return;
      case "enter-agent":
        this.cardScroll = 0;
        this.detailLevel = "agent";
        this.ctx?.requestRender();
        return;
      case "back":
        this.goBackLevel(itemCount);
        return;
      case "toggle-prompt":
        this.togglePrompt(action.label);
        return;
      case "cycle-filter":
        if (phase) this.cycleAgentFilter(phase.agents, workflowActive);
        return;
      case "pause":
        pauseWorkflowTask(item.id);
        this.ctx?.requestRender();
        return;
      case "resume":
        this.resumeWorkflow(item);
        return;
      case "stop":
        killWorkflowTask(item.id, true);
        this.ctx?.requestRender();
        return;
      case "retry-agent":
        retryWorkflowAgent(action.agentId);
        this.ctx?.requestRender();
        return;
      case "skip-agent":
        skipWorkflowAgent(action.agentId);
        this.ctx?.requestRender();
        return;
      case "save":
        this.openSave(item.id);
    }
  }

  private items(): WorkflowListItem[] {
    return mergeItems(listWorkflowTasks(), this.history);
  }

  private hasRunning(): boolean {
    return listWorkflowTasks().some((task) => task.status === "running");
  }

  private cwd(): string {
    if (this.cwdHint) return this.cwdHint;
    const live = listWorkflowTasks()[0];
    return live?.cwd ?? process.cwd();
  }

  private sessionId(): string | undefined {
    if (this.sessionIdHint) return this.sessionIdHint;
    const live = listWorkflowTasks().find((task) => task.sessionId)?.sessionId;
    if (live) return live;
    return getActiveSessionId() ?? undefined;
  }

  private async reloadHistory(): Promise<void> {
    const sessionId = this.sessionId();
    const cwd = this.cwd();
    if (!sessionId) {
      this.loading = false;
      this.ctx?.requestRender();
      return;
    }
    try {
      this.history = await loadWorkflowHistory(cwd, sessionId);
    } catch {
      // Keep previous history on load failure.
    } finally {
      this.loading = false;
      this.clampListCursor();
      this.ctx?.requestRender();
    }
  }

  private maybeAutoOpen(items: WorkflowListItem[]): void {
    if (this.loading || this.autoOpened || this.view.mode !== "list") return;
    if (items.length === 1) {
      this.autoOpened = true;
      const only = items[0];
      if (only) this.openDetail(only.id);
    }
  }

  private openDetail(itemId: string): void {
    this.view = { mode: "detail", itemId };
    this.detailLevel = "phases";
    this.phaseCursor = 0;
    this.agentCursor = 0;
    this.cardScroll = 0;
    this.ctx?.requestRender();
  }

  /** A narrowed list is a different set of rows, so the reader restarts at its top. */
  private cycleAgentFilter(agents: MergedPhase["agents"], workflowActive: boolean): void {
    this.agentFilter = nextAgentFilter({ current: this.agentFilter, agents, workflowActive });
    this.agentCursor = 0;
    this.cardScroll = 0;
    this.ctx?.requestRender();
  }

  private openSave(itemId: string): void {
    this.saveForm = openSaveForm(this.items().find((candidate) => candidate.id === itemId));
    this.view = { mode: "save", itemId };
    this.ctx?.requestRender();
  }

  private goBackFromDetail(itemCount: number): void {
    if (this.directDetail) {
      this.close();
      return;
    }
    if (this.autoOpened && itemCount <= 1) {
      this.close();
      return;
    }
    this.autoOpened = false;
    this.view = { mode: "list" };
    this.detailLevel = "phases";
    this.ctx?.requestRender();
  }

  private goBackLevel(itemCount: number): void {
    if (this.detailLevel === "agent") {
      this.detailLevel = "agents";
      this.cardScroll = 0;
      this.ctx?.requestRender();
      return;
    }
    if (this.detailLevel === "agents") {
      this.detailLevel = "phases";
      // The filter belongs to the list the reader was standing in; stepping out of
      // that list drops it, so returning never lands on a narrowed view they forgot.
      this.agentFilter = "all";
      this.ctx?.requestRender();
      return;
    }
    this.goBackFromDetail(itemCount);
  }

  private moveCursor(delta: number, phases: MergedPhase[], workflowActive: boolean): void {
    if (this.detailLevel === "phases") {
      this.phaseCursor = clamp(this.phaseCursor + delta, 0, Math.max(0, phases.length - 1));
      this.agentCursor = 0;
      this.cardScroll = 0;
      this.agentFilter = "all";
      this.ctx?.requestRender();
      return;
    }
    const phase = phases[this.phaseCursor];
    const count = filterAgents({
      agents: phase?.agents ?? [],
      filter: this.agentFilter,
      workflowActive,
    }).length;
    this.agentCursor = clamp(this.agentCursor + delta, 0, Math.max(0, count - 1));
    this.cardScroll = 0;
    this.ctx?.requestRender();
  }

  // The render clamps the far end, since only it knows how tall the card came out.
  private moveCard(delta: number): void {
    this.cardScroll = Math.max(0, this.cardScroll + delta);
    this.ctx?.requestRender();
  }

  private togglePrompt(label: string): void {
    if (this.expandedPrompts.has(label)) this.expandedPrompts.delete(label);
    else this.expandedPrompts.add(label);
    this.cardScroll = 0;
    this.ctx?.requestRender();
  }

  private resumeWorkflow(item: WorkflowListItem): void {
    if (item.scriptPath === undefined) return;
    const call = buildWorkflowResumeCall({
      scriptPath: item.scriptPath,
      runId: item.runId,
      args: item.args,
    });
    const prompt = `Resume the paused workflow: ${call}`;
    const existing = getPromptText();
    setPromptText(existing.length > 0 ? `${prompt}\n${existing}` : prompt);
    this.close();
  }

  private async saveTo(item: WorkflowListItem, scope: SaveScope): Promise<void> {
    const outcome = await saveWorkflowScript(item, this.saveForm.name, scope, this.projectRoot);
    if (outcome.kind === "saved") this.view = { mode: "saved", path: outcome.path };
    else if (outcome.kind === "exists") {
      this.view = { mode: "save-error", itemId: item.id, path: outcome.path };
    } else this.view = { mode: "list" };
    this.ctx?.requestRender();
  }

  private clampListCursor(count?: number): void {
    const total = count ?? this.items().length;
    if (total === 0) {
      this.cursor = 0;
      return;
    }
    this.cursor = Math.max(0, Math.min(total - 1, this.cursor));
  }
}

function narrowProps(props: unknown): PanelProps {
  if (!props || typeof props !== "object") return {};
  const record = props as Record<string, unknown>;
  const out: PanelProps = {};
  if (typeof record.sessionId === "string") out.sessionId = record.sessionId;
  if (typeof record.cwd === "string") out.cwd = record.cwd;
  if (typeof record.initialDetailItemId === "string") {
    out.initialDetailItemId = record.initialDetailItemId;
  }
  return out;
}

export function createWorkflowsPanel(close: () => void, props?: unknown): StringViewPanel {
  return new WorkflowsPanel(close, props);
}
