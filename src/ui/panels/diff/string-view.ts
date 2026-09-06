import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { hintChord, hintFor, type PanelHint } from "@/ui/chrome/panel-hints.ts";
import { cycleTabForKey } from "@/ui/chrome/panel-tabs.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  footerPanelBodyBudget,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import { patchLineForPath, statusPath, steppedCursor } from "@/ui/panels/diff/file-list.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/** Git working-tree snapshot collected for the panel body (same shape as the React panel). */
export interface DiffSnapshot {
  ok: boolean;
  branch: string;
  status: string[];
  stat: string[];
  patch: string[];
  error?: string;
}

type DiffTab = "summary" | "patch";

const TABS = [{ label: "Summary" }, { label: "Patch" }] as const;
const ROW_LABEL_WIDTH = 18;
const STATUS_CAP = 14;
const STAT_CAP = 8;
const PATCH_LINE_CAP = 400;
const CONTENT_PAD = 2;

/** The summary walks a list; the patch scrolls. The hints say which. */
const SUMMARY_HINTS: [string, string][] = [
  hintFor("switch"),
  hintFor("arrowsSelect"),
  hintFor("enterView"),
  hintFor("refresh"),
  hintFor("close"),
].map(hintPair);

const PATCH_HINTS: [string, string][] = [
  hintFor("switch"),
  hintFor("arrowsScroll"),
  hintFor("pageScroll"),
  hintFor("refresh"),
  hintFor("close"),
].map(hintPair);

/**
 * Uncommitted git diff browser on the string model. Collects branch/status/stat/patch
 * on open (and on `r`), shows a Summary tab plus a scrollable Patch tab with +/- line
 * coloring. Tab/←/→ cycle tabs (shared header focus model); Escape closes. An opener
 * may supply a pre-collected snapshot, which skips the initial git collection.
 */
class DiffPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private tab: DiffTab = "summary";
  /** Which changed file the summary's cursor is on. */
  private fileCursor = 0;
  /**
   * How many rows the cursor may walk — a fact about the snapshot rather than
   * about drawing, so the footer does not name last frame's list.
   */
  private get fileCount(): number {
    return Math.min(this.snapshot?.status.length ?? 0, STATUS_CAP);
  }
  /** A row the next frame should scroll to, once it knows how far it can. */
  private pendingScroll: number | null = null;
  private scroll = 0;
  // Scroll geometry the last paint resolved: the body window and the furthest
  // offset it can hold. Key handling reads them so a page or edge jump lands on
  // the same bounds the frame was drawn with.
  private viewportRows = 0;
  private maxScroll = 0;
  private snapshot: DiffSnapshot | null;

  constructor(
    private readonly close: () => void,
    snapshot: DiffSnapshot | null = null,
  ) {
    this.snapshot = snapshot;
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    if (this.snapshot === null) this.refresh();
    ctx.requestRender();
  }

  unmount(): void {
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - CONTENT_PAD * 2);
    const terminalRows = this.terminalRows();
    const spec: FooterPanelSpec = {
      command: "/diff",
      title: "Diff",
      tabs: [...TABS],
      activeTab: this.tab === "summary" ? 0 : 1,
      // Tabs are the panel's only focusable region: the header always holds focus.
      headerFocused: true,
      footerHints: this.tab === "summary" && this.fileCount > 0 ? SUMMARY_HINTS : PATCH_HINTS,
      maxRows: terminalRows,
      body: [],
    };

    // Line-scrolled body: the shared budget bounds the window, the panel owns
    // the scroll offset.
    const body = this.bodyLines(contentWidth);
    const budget = footerPanelBodyBudget(spec, terminalRows, width);
    const maxScroll = Math.max(0, body.length - budget);
    this.viewportRows = budget;
    this.maxScroll = maxScroll;
    // A jump asked for a line before the body existed; it is honoured here,
    // where how far the patch actually reaches is finally known.
    if (this.pendingScroll !== null) {
      this.scroll = Math.min(this.pendingScroll, maxScroll);
      this.pendingScroll = null;
    }
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    spec.body = body.slice(this.scroll, this.scroll + budget);
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    const cycledTab = cycleTabForKey({
      key,
      activeTab: this.tab === "summary" ? 0 : 1,
      tabCount: TABS.length,
      headerFocused: true,
    });
    if (cycledTab !== undefined) {
      this.tab = cycledTab === 0 ? "summary" : "patch";
      this.scroll = 0;
      this.ctx?.requestRender();
      return;
    }
    // On the summary the arrows walk the file list; on the patch they scroll it.
    if (this.tab === "summary" && this.fileCount > 0) {
      if (key.name === "up" || key.name === "down") {
        this.fileCursor = steppedCursor(
          this.fileCursor,
          key.name === "up" ? -1 : 1,
          this.fileCount,
        );
        this.ctx?.requestRender();
        return;
      }
      if (key.name === "return") {
        this.openSelectedFile();
        return;
      }
    }
    switch (key.name) {
      case "up":
        this.scrollBy(-1);
        return;
      case "down":
        this.scrollBy(1);
        return;
      case "pageup":
        this.scrollBy(-this.pageStep());
        return;
      case "pagedown":
        this.scrollBy(this.pageStep());
        return;
      case "home":
        this.setScroll(0);
        return;
      case "end":
        this.setScroll(this.maxScroll);
        return;
      case "escape":
        this.close();
        return;
    }
    if (key.sequence === "q") {
      this.close();
      return;
    }
    if (key.sequence === "r") {
      this.refresh();
    }
  }

  /** A page key moves half the visible body, so a landmark row stays on screen. */
  private pageStep(): number {
    return Math.max(1, Math.floor(this.viewportRows / 2));
  }

  /** A step only floors at the top; the paint bounds the far end against the body. */
  private scrollBy(delta: number): void {
    this.setScroll(Math.max(0, this.scroll + delta));
  }

  private setScroll(next: number): void {
    if (next === this.scroll) return;
    this.scroll = next;
    this.ctx?.requestRender();
  }

  private refresh(): void {
    this.snapshot = null;
    this.scroll = 0;
    this.ctx?.requestRender();
    void collectGitDiff().then((next) => {
      this.snapshot = next;
      this.scroll = 0;
      this.ctx?.requestRender();
    });
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  /**
   * Opens the patch at the selected file. A file the patch does not carry —
   * staged only, or untracked — opens the patch where it is rather than
   * pretending to jump.
   */
  private openSelectedFile(): void {
    const snapshot = this.snapshot;
    const line = snapshot?.status[this.fileCursor];
    const path = line === undefined ? null : statusPath(line);
    this.tab = "patch";
    this.scroll = 0;
    const at = path === null || snapshot === null ? null : patchLineForPath(snapshot.patch, path);
    if (at !== null) this.pendingScroll = at;
    this.ctx?.requestRender();
  }

  private bodyLines(contentWidth: number): string[] {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      return [renderTextWithStyles("loading git diff", { color: Color.muted })];
    }
    if (this.tab === "summary") return this.summaryLines(snapshot, contentWidth);
    return this.patchLines(snapshot);
  }

  private summaryLines(snapshot: DiffSnapshot, contentWidth: number): string[] {
    if (!snapshot.ok) {
      return [
        renderTextWithStyles(snapshot.error ?? "git diff unavailable", { color: Color.error }),
      ];
    }

    const body: string[] = [];
    body.push(
      renderPanelRowLine(
        { label: "Branch", value: snapshot.branch },
        contentWidth,
        ROW_LABEL_WIDTH,
      ),
    );
    body.push(
      renderPanelRowLine(
        { label: "Changed files", value: String(snapshot.status.length) },
        contentWidth,
        ROW_LABEL_WIDTH,
      ),
    );
    body.push("");

    if (snapshot.status.length === 0) {
      body.push(renderTextWithStyles("working tree clean", { color: Color.muted }));
    } else {
      const shown = snapshot.status.slice(0, STATUS_CAP);
      shown.forEach((line, index) => {
        const selected = index === this.fileCursor;
        body.push(
          renderTextWithStyles(selected ? Glyph.chevron : "  ", {
            color: selected ? Color.panelAccent : Color.muted,
          }) + renderTextWithStyles(line, { color: selected ? Color.panelAccent : Color.text }),
        );
      });
    }

    if (snapshot.stat.length > 0) {
      body.push("");
      for (const line of snapshot.stat.slice(0, STAT_CAP)) {
        body.push(renderTextWithStyles(line, { color: Color.muted }));
      }
    }
    return body;
  }

  private patchLines(snapshot: DiffSnapshot): string[] {
    if (!snapshot.ok) {
      return [
        renderTextWithStyles(snapshot.error ?? "git diff unavailable", { color: Color.error }),
      ];
    }
    if (snapshot.patch.length === 0) {
      return [renderTextWithStyles("no unstaged patch", { color: Color.muted })];
    }
    // Neutral helper `renderDiffAnsiLines` was deleted with React (tool-render/diff.tsx).
    // Color +/-/@@ lines inline the same way the React fallback path did.
    return snapshot.patch.map(colorDiffLine);
  }
}

function hintPair(hint: PanelHint): [string, string] {
  return [hintChord(hint.keys), hint.label];
}

function colorDiffLine(line: string): string {
  let color = Color.muted;
  if (line.startsWith("+") && !line.startsWith("+++")) color = Color.success;
  else if (line.startsWith("-") && !line.startsWith("---")) color = Color.error;
  else if (line.startsWith("@@")) color = Color.panelAccent;
  return renderTextWithStyles(line, { color });
}

async function collectGitDiff(cwd = process.cwd()): Promise<DiffSnapshot> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.exit !== 0 || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      branch: "",
      status: [],
      stat: [],
      patch: [],
      error: "not inside a git repository",
    };
  }
  const [branch, status, stat, patch] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["status", "--short"], cwd),
    runGit(["diff", "--stat", "--color=never"], cwd),
    runGit(["diff", "--color=never", "--"], cwd),
  ]);
  return {
    ok: true,
    branch: branch.stdout.trim() || "(detached)",
    status: lines(status.stdout),
    stat: lines(stat.stdout),
    patch: lines(patch.stdout).slice(0, PATCH_LINE_CAP),
  };
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit: typeof exit === "number" ? exit : -1, stdout, stderr };
}

function lines(value: string): string[] {
  return value.split("\n").filter((line) => line.length > 0);
}

function narrowSnapshot(props: unknown): DiffSnapshot | null {
  if (typeof props !== "object" || props === null) return null;
  const snapshot = (props as Record<string, unknown>).snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const record = snapshot as Record<string, unknown>;
  if (typeof record.ok !== "boolean" || !Array.isArray(record.patch)) return null;
  return snapshot as DiffSnapshot;
}

export function createDiffPanel(close: () => void, props?: unknown): StringViewPanel {
  return new DiffPanel(close, narrowSnapshot(props));
}
