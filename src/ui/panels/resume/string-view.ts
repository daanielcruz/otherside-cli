import { appendCustomTitleToPath } from "@/engine/session/index.ts";
import {
  listSessionFileStats,
  listSlugSessionFileStats,
  type SessionCwdFilter,
  type SessionFileStat,
  sessionCwdFilterFor,
  sessionCwdFilterSeed,
} from "@/engine/session/paths.ts";
import { readActiveChainLines, recordsFromLines } from "@/engine/session/persist.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { clampIndex } from "@/kernel/std/math.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { keyInput } from "@/ui/chrome/key-input.ts";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { FALLBACK_TERMINAL_ROWS } from "@/ui/chrome/string-view-panel.ts";
import {
  type ResumeMode,
  resumeKeyAction,
  submitResumeSelection,
} from "@/ui/panels/resume/controller.ts";
import {
  applyOutcomes,
  enrichSlice,
  isListedEntry,
  liteEntryFrom,
  mergeStatRows,
  type PreviewState,
  previewLinesFromRecords,
  type SessionEntry,
  searchTextFor,
} from "@/ui/panels/resume/entries.ts";
import { renderResumeList } from "@/ui/panels/resume/list.ts";
import { currentBranchFrom, foldText } from "@/ui/panels/resume/picker-view.ts";
import { renderResumePreview } from "@/ui/panels/resume/preview.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";

/**
 * Opener payload for the resume overlay. Without `onResumeSession` the list
 * still renders; Enter reports the picker as unwired instead of resuming.
 */
export interface ResumePanelProps {
  onResumeSession?: (id: string) => void | Promise<void>;
}

/**
 * Session resume picker on the string model. Loads sessions for the current cwd
 * (lite seed, then full stats + progressive enrich), supports search / rename /
 * preview, and resumes the selected session on Enter when `onResumeSession` is
 * provided via props.
 */
class ResumePanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private alive = false;

  private cwdFilter: SessionCwdFilter | undefined;
  private statRows: SessionFileStat[];
  private entries: SessionEntry[];

  private query = "";
  private cursor = 0;
  private showAllProjects = false;
  private branchFilterEnabled = false;
  private mode: ResumeMode = "list";
  private preview: PreviewState | null = null;
  private previewScroll = 0;
  private rename: { id: string; path: string; value: string } | null = null;
  private resumeError: string | null = null;
  private loading = true;

  /** Anchor-scroll state and the page sizes the last render produced. */
  private listStart = 0;
  private visibleSessionCount = 1;
  private visiblePreviewRows = 1;

  private enrichNext = 0;
  private enrichRunning = false;

  private readonly onResumeSession: ((id: string) => void | Promise<void>) | undefined;

  constructor(
    private readonly close: () => void,
    props?: ResumePanelProps,
  ) {
    const seedFilter = sessionCwdFilterSeed(process.cwd());
    this.cwdFilter = seedFilter;
    this.statRows = listSlugSessionFileStats(seedFilter);
    this.entries = this.statRows.map(liteEntryFrom);
    this.onResumeSession = props?.onResumeSession;
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.alive = true;
    ctx.requestRender();
    void this.loadSessions();
    this.kickEnrich();
  }

  unmount(): void {
    this.alive = false;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    if (this.mode === "preview" && this.preview) {
      return this.renderPreview(width);
    }
    return this.renderList(width);
  }

  handleKey(key: KeyEventData): void {
    if (this.mode === "list" && key.ctrl && key.name?.toLowerCase() === "a") {
      this.showAllProjects = !this.showAllProjects;
      this.loading = true;
      this.cursor = 0;
      this.ctx?.requestRender();
      void this.loadSessions();
      return;
    }
    if (this.mode === "list" && key.ctrl && key.name?.toLowerCase() === "b") {
      this.branchFilterEnabled = !this.branchFilterEnabled;
      this.cursor = 0;
      this.clampCursor();
      this.ctx?.requestRender();
      return;
    }

    const sessions = this.filteredSessions();
    const input = keyInput(key);
    const action = resumeKeyAction(this.mode, input, asResumeKey(key), {
      selectedIndex: this.cursor,
      queryLength: this.query.length,
    });

    switch (action.type) {
      case "none":
        // Typing seeds this list's search, so the shared list vocabulary only gets
        // the keys the picker itself declined: the chords and the edge keys.
        this.applyListSelect(key, sessions);
        return;
      case "close":
        this.close();
        return;
      case "enter-search":
        this.mode = "search";
        if (action.seed.length > 0) this.query += action.seed;
        this.cursor = 0;
        this.ctx?.requestRender();
        return;
      case "clear-search":
        this.query = "";
        this.cursor = 0;
        this.ctx?.requestRender();
        return;
      case "search-append":
        this.query += action.text;
        this.cursor = 0;
        this.ctx?.requestRender();
        return;
      case "search-delete":
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
        this.ctx?.requestRender();
        return;
      case "back-to-list":
        this.mode = "list";
        this.preview = null;
        this.rename = null;
        this.cursor = 0;
        this.ctx?.requestRender();
        return;
      case "move":
        this.cursor = clampIndex(this.cursor + action.delta, sessions.length);
        this.ctx?.requestRender();
        return;
      case "page": {
        const page = Math.max(1, this.visibleSessionCount);
        this.cursor = clampIndex(this.cursor + action.delta * page, sessions.length);
        this.ctx?.requestRender();
        return;
      }
      case "preview": {
        const selected = sessions[this.cursor];
        if (selected) this.openPreview(selected);
        return;
      }
      case "preview-scroll":
        this.previewScroll = Math.max(0, this.previewScroll + action.delta);
        this.ctx?.requestRender();
        return;
      case "preview-page": {
        const page = Math.max(1, this.visiblePreviewRows);
        this.previewScroll = Math.max(0, this.previewScroll + action.delta * page);
        this.ctx?.requestRender();
        return;
      }
      case "enter-rename": {
        const selected = sessions[this.cursor];
        if (selected) {
          this.rename = { id: selected.id, path: selected.path, value: "" };
          this.mode = "rename";
          this.ctx?.requestRender();
        }
        return;
      }
      case "rename-append":
        if (this.rename) {
          this.rename = { ...this.rename, value: this.rename.value + action.text };
          this.ctx?.requestRender();
        }
        return;
      case "rename-delete":
        if (this.rename) {
          this.rename = { ...this.rename, value: this.rename.value.slice(0, -1) };
          this.ctx?.requestRender();
        }
        return;
      case "rename-save":
        this.submitRename();
        return;
      case "resume":
        this.resumeSelected(this.mode === "preview" ? this.preview?.id : sessions[this.cursor]?.id);
        return;
    }
  }

  /** Shared list navigation for the root list; other modes keep their own keys. */
  private applyListSelect(key: KeyEventData, sessions: SessionEntry[]): void {
    if (this.mode !== "list") return;
    const action = listSelectKey(key, {
      cursor: this.cursor,
      count: sessions.length,
      pageSize: Math.max(1, this.visibleSessionCount),
    });
    if (action === undefined) return;
    this.cursor = action.cursor;
    if (action.activate) {
      this.resumeSelected(sessions[this.cursor]?.id);
      return;
    }
    this.ctx?.requestRender();
  }

  private async loadSessions(): Promise<void> {
    try {
      const showAllProjects = this.showAllProjects;
      const filter = showAllProjects ? undefined : await sessionCwdFilterFor(process.cwd());
      const rows = await listSessionFileStats(filter);
      if (!this.alive || this.showAllProjects !== showAllProjects) return;
      this.cwdFilter = filter;
      this.statRows = rows;
      this.entries = mergeStatRows(this.entries, rows);
      this.enrichNext = 0;
      this.loading = false;
      this.clampCursor();
      this.ctx?.requestRender();
      this.kickEnrich();
    } catch (error: unknown) {
      if (!this.alive) return;
      this.loading = false;
      this.resumeError = errorMessage(error);
      this.ctx?.requestRender();
    }
  }

  private kickEnrich(): void {
    if (!this.alive || this.enrichRunning || this.enrichNext >= this.statRows.length) return;
    const sessions = this.filteredSessions();
    const hasLite = sessions.some((row) => row.phase === "lite");
    const searching = this.query.length > 0;
    if (this.enrichNext > 0 && !hasLite && !searching) return;

    this.enrichRunning = true;
    void enrichSlice({
      rows: this.statRows,
      startIndex: this.enrichNext,
      filter: this.cwdFilter,
      onFlush: (outcomes) => {
        if (!this.alive) return;
        this.entries = applyOutcomes(this.entries, outcomes);
        this.clampCursor();
        this.ctx?.requestRender();
      },
    })
      .then((nextIndex) => {
        this.enrichNext = nextIndex;
        this.enrichRunning = false;
        if (this.alive) this.kickEnrich();
      })
      .catch(() => {
        this.enrichRunning = false;
      });
  }

  private filteredSessions(): SessionEntry[] {
    const all = this.entries.filter(isListedEntry);
    const branch = currentBranchFrom(all);
    const branchFiltered =
      this.branchFilterEnabled && branch !== null
        ? all.filter(
            (session) => session.phase === "enriched" && (session.branch ?? "HEAD") === branch,
          )
        : all;
    const query = foldText(this.query);
    if (query.length === 0) return branchFiltered;
    return branchFiltered.filter((session) => foldText(searchTextFor(session)).includes(query));
  }

  private clampCursor(): void {
    const n = this.filteredSessions().length;
    this.cursor = Math.min(Math.max(0, n - 1), Math.max(0, this.cursor));
  }

  private openPreview(entry: SessionEntry): void {
    this.preview = { id: entry.id, updatedAt: entry.updatedAt, lines: [], loading: true };
    this.previewScroll = 0;
    this.mode = "preview";
    this.ctx?.requestRender();
    void readActiveChainLines(entry.id)
      .then((lines) => recordsFromLines(lines))
      .then((records) => {
        if (!this.alive) return;
        if (this.preview?.id !== entry.id) return;
        this.preview = {
          ...this.preview,
          lines: previewLinesFromRecords(records),
          loading: false,
        };
        this.ctx?.requestRender();
      })
      .catch((error: unknown) => {
        if (!this.alive) return;
        if (this.preview?.id !== entry.id) return;
        this.preview = {
          ...this.preview,
          loading: false,
          error: errorMessage(error),
        };
        this.ctx?.requestRender();
      });
  }

  private submitRename(): void {
    if (!this.rename) return;
    const trimmed = this.rename.value.trim();
    const { id, path } = this.rename;
    this.rename = null;
    this.mode = "list";
    if (trimmed.length === 0) {
      this.ctx?.requestRender();
      return;
    }
    this.entries = this.entries.map((entry) =>
      entry.id === id && entry.phase === "enriched" ? { ...entry, title: trimmed } : entry,
    );
    this.ctx?.requestRender();
    void appendCustomTitleToPath(path, id, trimmed).catch(() => {});
  }

  private resumeSelected(id: string | undefined): void {
    if (id === undefined) return;
    if (!this.onResumeSession) {
      this.resumeError =
        "Resume action is not wired — pass onResumeSession via overlay props (createResumeSession from session-ops).";
      this.ctx?.requestRender();
      return;
    }
    this.resumeError = null;
    this.ctx?.requestRender();
    void submitResumeSelection(id, this.onResumeSession, this.close).then((err) => {
      if (!this.alive) return;
      this.resumeError = err;
      this.ctx?.requestRender();
    });
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private renderList(width: number): string[] {
    const layout = renderResumeList(
      {
        sessions: this.filteredSessions(),
        branch: currentBranchFrom(this.entries.filter(isListedEntry)),
        cursor: this.cursor,
        query: this.query,
        mode: this.mode,
        rename: this.rename,
        showAllProjects: this.showAllProjects,
        branchFilterEnabled: this.branchFilterEnabled,
        loading: this.loading,
        resumeError: this.resumeError,
        previousStart: this.listStart,
        previousVisibleCount: this.visibleSessionCount,
        terminalRows: this.terminalRows(),
      },
      width,
    );
    this.listStart = layout.listStart;
    this.visibleSessionCount = layout.visibleSessionCount;
    return layout.rows;
  }

  private renderPreview(width: number): string[] {
    const layout = renderResumePreview(
      {
        preview: this.preview!,
        resumeError: this.resumeError,
        scroll: this.previewScroll,
        previousVisibleRows: this.visiblePreviewRows,
        terminalRows: this.terminalRows(),
      },
      width,
    );
    this.previewScroll = layout.scroll;
    this.visiblePreviewRows = layout.visiblePreviewRows;
    return layout.rows;
  }
}

/**
 * The descriptor the controller reasons over. The two panel-level keys are asked
 * of the binding table so rebinding reaches here too; the rest are the list's own
 * navigation, which the controller already interprets per mode.
 */
function asResumeKey(key: KeyEventData) {
  const panelAction = panelKey(key);
  return {
    upArrow: key.name === "up",
    downArrow: key.name === "down",
    pageUp: key.name === "pageup",
    pageDown: key.name === "pagedown",
    return: panelAction === "confirm",
    escape: panelAction === "close",
    backspace: key.name === "backspace",
    delete: key.name === "delete",
    ctrl: key.ctrl,
    meta: key.meta,
  };
}

function narrowProps(props: ResumePanelProps | unknown): ResumePanelProps | undefined {
  if (typeof props !== "object" || props === null) return undefined;
  const record = props as Record<string, unknown>;
  const out: ResumePanelProps = {};
  if (typeof record.onResumeSession === "function") {
    out.onResumeSession = record.onResumeSession as (id: string) => void | Promise<void>;
  }
  return out;
}

export function createResumePanel(close: () => void, props?: ResumePanelProps): StringViewPanel {
  return new ResumePanel(close, narrowProps(props));
}
